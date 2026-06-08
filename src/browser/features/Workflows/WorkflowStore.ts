import { useCallback, useContext, useEffect, useSyncExternalStore } from "react";

import { APIContext, type APIClient } from "@/browser/contexts/API";
import assert from "@/common/utils/assert";
import type { WorkflowDefinitionDescriptor, WorkflowRunRecord } from "@/common/types/workflow";

import {
  compareWorkflowRunsForAttention,
  groupWorkflowDefinitionsByScope,
  summarizeWorkflowRuns,
  type WorkflowRunsSummary,
} from "./workflowStatusPresentation";

export const WORKFLOW_RUN_POLL_INTERVAL_MS = 2000;
export const WORKFLOW_WORKSPACE_REFRESH_INTERVAL_MS = 10_000;

export interface WorkflowStoreOptions {
  runPollIntervalMs?: number;
  workspaceRefreshIntervalMs?: number;
}

export interface WorkflowWorkspaceSnapshot {
  definitions: WorkflowDefinitionDescriptor[];
  definitionGroups: ReturnType<typeof groupWorkflowDefinitionsByScope>;
  runs: WorkflowRunRecord[];
  currentRuns: WorkflowRunRecord[];
  historyRuns: WorkflowRunRecord[];
  summary: WorkflowRunsSummary;
  isLoading: boolean;
  error: string | null;
}

const EMPTY_DEFINITION_GROUPS = groupWorkflowDefinitionsByScope([]);
const EMPTY_SUMMARY = summarizeWorkflowRuns([]);
const EMPTY_SNAPSHOT: WorkflowWorkspaceSnapshot = {
  definitions: [],
  definitionGroups: EMPTY_DEFINITION_GROUPS,
  runs: [],
  currentRuns: [],
  historyRuns: [],
  summary: EMPTY_SUMMARY,
  isLoading: false,
  error: null,
};

type Listener = () => void;

interface WorkspaceState {
  definitions: WorkflowDefinitionDescriptor[];
  runs: WorkflowRunRecord[];
  snapshot: WorkflowWorkspaceSnapshot;
  isLoading: boolean;
  error: string | null;
}

export class WorkflowStore {
  private client: APIClient | null = null;
  private readonly listenersByWorkspace = new Map<string, Set<Listener>>();
  private readonly states = new Map<string, WorkspaceState>();
  private readonly inFlightSnapshots = new Set<string>();
  private readonly pendingSnapshotRefreshes = new Set<string>();
  private readonly runTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly workspaceRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runPollIntervalMs: number;
  private readonly workspaceRefreshIntervalMs: number;
  private disposed = false;

  constructor(options: WorkflowStoreOptions = {}) {
    this.runPollIntervalMs = options.runPollIntervalMs ?? WORKFLOW_RUN_POLL_INTERVAL_MS;
    this.workspaceRefreshIntervalMs =
      options.workspaceRefreshIntervalMs ?? WORKFLOW_WORKSPACE_REFRESH_INTERVAL_MS;
    assert(this.runPollIntervalMs > 0, "Workflow run poll interval must be positive");
    assert(
      this.workspaceRefreshIntervalMs > 0,
      "Workflow workspace refresh interval must be positive"
    );
  }

  setClient(client: APIClient | null): void {
    this.client = client;
    if (client == null || this.disposed) return;

    for (const workspaceId of this.listenersByWorkspace.keys()) {
      this.refreshWorkspace(workspaceId);
    }
  }

  subscribeWorkspace = (workspaceId: string, listener: Listener): (() => void) => {
    assert(workspaceId.length > 0, "WorkflowStore subscriptions require a workspace id");
    let listeners = this.listenersByWorkspace.get(workspaceId);
    if (listeners == null) {
      listeners = new Set<Listener>();
      this.listenersByWorkspace.set(workspaceId, listeners);
    }
    listeners.add(listener);

    const state = this.states.get(workspaceId);
    if (state == null && !this.inFlightSnapshots.has(workspaceId)) {
      queueMicrotask(() => this.refreshWorkspace(workspaceId));
    } else if (state != null) {
      // React may unsubscribe/resubscribe external stores during ordinary commits. Keep the
      // cached snapshot for layout stability, but restart polling for active cached runs.
      this.syncRunPolling(workspaceId, state.runs);
      this.scheduleWorkspaceRefresh(workspaceId);
    }

    return () => {
      const currentListeners = this.listenersByWorkspace.get(workspaceId);
      currentListeners?.delete(listener);
      if (currentListeners?.size === 0) {
        this.listenersByWorkspace.delete(workspaceId);
        this.pendingSnapshotRefreshes.delete(workspaceId);
        this.stopWorkspaceRunPolling(workspaceId);
        this.clearWorkspaceRefreshTimer(workspaceId);
      }
    };
  };

  getWorkspaceSnapshot(workspaceId: string | undefined): WorkflowWorkspaceSnapshot {
    if (!workspaceId) return EMPTY_SNAPSHOT;
    return this.states.get(workspaceId)?.snapshot ?? EMPTY_SNAPSHOT;
  }

  getWorkspaceSummary(workspaceId: string | undefined): WorkflowRunsSummary {
    return this.getWorkspaceSnapshot(workspaceId).summary;
  }

  invalidateWorkspace(workspaceId: string): void {
    this.refreshWorkspace(workspaceId, { queueIfInFlight: true });
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.runTimers.values()) clearTimeout(timer);
    for (const timer of this.workspaceRefreshTimers.values()) clearTimeout(timer);
    this.runTimers.clear();
    this.workspaceRefreshTimers.clear();
    this.listenersByWorkspace.clear();
    this.states.clear();
    this.inFlightSnapshots.clear();
    this.pendingSnapshotRefreshes.clear();
  }

  private refreshWorkspace(workspaceId: string, options: { queueIfInFlight?: boolean } = {}): void {
    if (this.client == null || this.disposed || !this.listenersByWorkspace.has(workspaceId)) return;
    if (this.inFlightSnapshots.has(workspaceId)) {
      if (options.queueIfInFlight === true) {
        this.pendingSnapshotRefreshes.add(workspaceId);
      }
      return;
    }

    this.clearWorkspaceRefreshTimer(workspaceId);
    this.inFlightSnapshots.add(workspaceId);
    this.updateWorkspaceLoading(workspaceId, true, null);
    void this.loadWorkspaceSnapshot(workspaceId);
  }

  private async loadWorkspaceSnapshot(workspaceId: string): Promise<void> {
    assert(this.client != null, "WorkflowStore cannot load workflows without an API client");
    const client = this.client;
    try {
      const [definitionsResult, runsResult] = await Promise.allSettled([
        client.workflows.listDefinitions({ workspaceId }),
        client.workflows.listRuns({ workspaceId }),
      ]);
      if (this.disposed) return;

      const current = this.states.get(workspaceId);
      const errors: string[] = [];
      const definitions = readSettledWorkflowValue(
        definitionsResult,
        current?.definitions ?? [],
        "definitions",
        errors
      );
      const runs = readSettledWorkflowValue(runsResult, current?.runs ?? [], "runs", errors);
      this.setWorkspaceData(
        workspaceId,
        definitions,
        runs,
        false,
        errors.length > 0 ? `Failed to load workflows: ${errors.join("; ")}` : null
      );
    } catch (error) {
      if (this.disposed) return;
      this.updateWorkspaceLoading(workspaceId, false, getWorkflowErrorMessage(error));
    } finally {
      this.inFlightSnapshots.delete(workspaceId);
      if (this.pendingSnapshotRefreshes.delete(workspaceId)) {
        queueMicrotask(() => this.refreshWorkspace(workspaceId));
      } else {
        this.scheduleWorkspaceRefresh(workspaceId);
      }
    }
  }

  private updateWorkspaceLoading(
    workspaceId: string,
    isLoading: boolean,
    error: string | null
  ): void {
    const current = this.states.get(workspaceId);
    this.setWorkspaceData(
      workspaceId,
      current?.definitions ?? [],
      current?.runs ?? [],
      isLoading,
      error
    );
  }

  private setWorkspaceData(
    workspaceId: string,
    definitions: WorkflowDefinitionDescriptor[],
    runs: WorkflowRunRecord[],
    isLoading: boolean,
    error: string | null
  ): void {
    const previousSummary = this.states.get(workspaceId)?.snapshot.summary;
    const orderedRuns = [...runs].sort(compareWorkflowRunsForAttention);
    const activeOrProblemRuns = orderedRuns.filter((run) => {
      const singleSummary = summarizeWorkflowRuns([run]);
      return singleSummary.activeCount > 0 || singleSummary.problemCount > 0;
    });
    const historyRuns = orderedRuns.filter((run) => !activeOrProblemRuns.includes(run));
    const nextSummary = summarizeWorkflowRuns(orderedRuns);
    const summary = areWorkflowSummariesEqual(previousSummary, nextSummary)
      ? previousSummary
      : nextSummary;
    const snapshot: WorkflowWorkspaceSnapshot = {
      definitions,
      definitionGroups: groupWorkflowDefinitionsByScope(definitions),
      runs: orderedRuns,
      currentRuns: activeOrProblemRuns,
      historyRuns,
      summary,
      isLoading,
      error,
    };
    this.states.set(workspaceId, { definitions, runs: orderedRuns, snapshot, isLoading, error });
    this.syncRunPolling(workspaceId, orderedRuns);
    this.scheduleWorkspaceRefresh(workspaceId);
    this.emit(workspaceId);
  }

  private syncRunPolling(workspaceId: string, runs: readonly WorkflowRunRecord[]): void {
    if (!this.listenersByWorkspace.has(workspaceId)) return;

    const activeRunIds = new Set(
      runs.filter((run) => summarizeWorkflowRuns([run]).activeCount > 0).map((run) => run.id)
    );
    for (const runId of activeRunIds) {
      const key = getRunKey(workspaceId, runId);
      if (!this.runTimers.has(key)) {
        this.scheduleRunPoll(workspaceId, runId);
      }
    }
    for (const key of Array.from(this.runTimers.keys())) {
      const { workspaceId: keyWorkspaceId, runId } = parseRunKey(key);
      if (keyWorkspaceId === workspaceId && !activeRunIds.has(runId)) {
        this.clearRunTimer(key);
      }
    }
  }

  private scheduleRunPoll(workspaceId: string, runId: string): void {
    assert(workspaceId.length > 0 && runId.length > 0, "Workflow run polling requires ids");
    const key = getRunKey(workspaceId, runId);
    if (this.runTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.runTimers.delete(key);
      void this.pollRun(workspaceId, runId);
    }, this.runPollIntervalMs);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
    this.runTimers.set(key, timer);
  }

  private async pollRun(workspaceId: string, runId: string): Promise<void> {
    if (this.client == null || this.disposed || !this.listenersByWorkspace.has(workspaceId)) return;
    try {
      const run = await this.client.workflows.getRun({ workspaceId, runId });
      if (this.disposed || !this.listenersByWorkspace.has(workspaceId)) return;
      if (run == null) {
        this.scheduleRunPollIfStillActive(workspaceId, runId);
        return;
      }

      const state = this.states.get(workspaceId);
      const currentRuns = state?.runs ?? [];
      const nextRuns = currentRuns.some((candidate) => candidate.id === run.id)
        ? currentRuns.map((candidate) => (candidate.id === run.id ? run : candidate))
        : [run, ...currentRuns];
      this.setWorkspaceData(
        workspaceId,
        state?.definitions ?? [],
        nextRuns,
        state?.isLoading ?? false,
        null
      );
    } catch (error) {
      if (this.disposed || !this.listenersByWorkspace.has(workspaceId)) return;
      this.updateWorkspaceLoading(
        workspaceId,
        this.states.get(workspaceId)?.isLoading ?? false,
        `Failed to refresh workflow run: ${getWorkflowErrorMessage(error)}`
      );
      this.scheduleRunPollIfStillActive(workspaceId, runId);
    }
  }

  private scheduleRunPollIfStillActive(workspaceId: string, runId: string): void {
    if (!this.listenersByWorkspace.has(workspaceId)) return;
    const run = this.states.get(workspaceId)?.runs.find((candidate) => candidate.id === runId);
    if (run == null || summarizeWorkflowRuns([run]).activeCount === 0) return;
    this.scheduleRunPoll(workspaceId, runId);
  }

  private scheduleWorkspaceRefresh(workspaceId: string): void {
    if (
      this.disposed ||
      !this.listenersByWorkspace.has(workspaceId) ||
      this.inFlightSnapshots.has(workspaceId) ||
      this.workspaceRefreshTimers.has(workspaceId)
    ) {
      return;
    }

    const timer = setTimeout(() => {
      this.workspaceRefreshTimers.delete(workspaceId);
      this.refreshWorkspace(workspaceId);
    }, this.workspaceRefreshIntervalMs);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
    this.workspaceRefreshTimers.set(workspaceId, timer);
  }

  private stopWorkspaceRunPolling(workspaceId: string): void {
    for (const key of Array.from(this.runTimers.keys())) {
      if (parseRunKey(key).workspaceId === workspaceId) {
        this.clearRunTimer(key);
      }
    }
  }

  private clearRunTimer(key: string): void {
    const timer = this.runTimers.get(key);
    if (timer != null) clearTimeout(timer);
    this.runTimers.delete(key);
  }

  private clearWorkspaceRefreshTimer(workspaceId: string): void {
    const timer = this.workspaceRefreshTimers.get(workspaceId);
    if (timer != null) clearTimeout(timer);
    this.workspaceRefreshTimers.delete(workspaceId);
  }

  private emit(workspaceId: string): void {
    const listeners = this.listenersByWorkspace.get(workspaceId);
    if (listeners == null) return;
    for (const listener of listeners) listener();
  }
}

function readSettledWorkflowValue<T>(
  result: PromiseSettledResult<T>,
  fallback: T,
  label: string,
  errors: string[]
): T {
  if (result.status === "fulfilled") return result.value;
  errors.push(`${label}: ${getWorkflowErrorMessage(result.reason)}`);
  return fallback;
}

function getWorkflowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown workflow error";
}

function areWorkflowSummariesEqual(
  left: WorkflowRunsSummary | undefined,
  right: WorkflowRunsSummary
): left is WorkflowRunsSummary {
  return (
    left != null &&
    left.activeCount === right.activeCount &&
    left.problemCount === right.problemCount &&
    left.highestSeverity === right.highestSeverity
  );
}

function getRunKey(workspaceId: string, runId: string): string {
  return JSON.stringify([workspaceId, runId]);
}

function parseRunKey(key: string): { workspaceId: string; runId: string } {
  const value: unknown = JSON.parse(key);
  assert(Array.isArray(value) && value.length === 2, "Invalid workflow run polling key");
  const workspaceId: unknown = value[0];
  const runId: unknown = value[1];
  assert(typeof workspaceId === "string" && typeof runId === "string", "Invalid workflow run ids");
  return { workspaceId, runId };
}

let workflowStoreInstance: WorkflowStore | null = null;

export function getWorkflowStoreInstance(): WorkflowStore {
  workflowStoreInstance ??= new WorkflowStore();
  return workflowStoreInstance;
}

export function useWorkflowWorkspaceSummary(workspaceId: string | undefined): WorkflowRunsSummary {
  const apiState = useContext(APIContext);
  const api = apiState?.api ?? null;
  const store = getWorkflowStoreInstance();

  useEffect(() => {
    store.setClient(api);
  }, [api, store]);

  const subscribe = useCallback(
    (listener: Listener) =>
      workspaceId ? store.subscribeWorkspace(workspaceId, listener) : () => undefined,
    [store, workspaceId]
  );

  return useSyncExternalStore(
    subscribe,
    () => store.getWorkspaceSummary(workspaceId),
    () => EMPTY_SUMMARY
  );
}

export function useWorkflowWorkspaceSnapshot(
  workspaceId: string | undefined
): WorkflowWorkspaceSnapshot {
  const apiState = useContext(APIContext);
  const api = apiState?.api ?? null;
  const store = getWorkflowStoreInstance();

  useEffect(() => {
    store.setClient(api);
  }, [api, store]);

  const subscribe = useCallback(
    (listener: Listener) =>
      workspaceId ? store.subscribeWorkspace(workspaceId, listener) : () => undefined,
    [store, workspaceId]
  );

  return useSyncExternalStore(
    subscribe,
    () => store.getWorkspaceSnapshot(workspaceId),
    () => EMPTY_SNAPSHOT
  );
}
