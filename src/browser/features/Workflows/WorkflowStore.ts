import { useContext, useEffect, useSyncExternalStore } from "react";

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
  private readonly runTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

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

    if (!this.states.has(workspaceId) && !this.inFlightSnapshots.has(workspaceId)) {
      queueMicrotask(() => this.refreshWorkspace(workspaceId));
    }

    return () => {
      const currentListeners = this.listenersByWorkspace.get(workspaceId);
      currentListeners?.delete(listener);
      if (currentListeners?.size === 0) {
        this.listenersByWorkspace.delete(workspaceId);
        this.stopWorkspaceRunPolling(workspaceId);
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
    this.refreshWorkspace(workspaceId);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.runTimers.values()) clearTimeout(timer);
    this.runTimers.clear();
    this.listenersByWorkspace.clear();
    this.states.clear();
    this.inFlightSnapshots.clear();
  }

  private refreshWorkspace(workspaceId: string): void {
    if (this.client == null || this.disposed || !this.listenersByWorkspace.has(workspaceId)) return;
    if (this.inFlightSnapshots.has(workspaceId)) return;

    this.inFlightSnapshots.add(workspaceId);
    this.updateWorkspaceLoading(workspaceId, true, null);
    void this.loadWorkspaceSnapshot(workspaceId);
  }

  private async loadWorkspaceSnapshot(workspaceId: string): Promise<void> {
    assert(this.client != null, "WorkflowStore cannot load workflows without an API client");
    const client = this.client;
    try {
      const [definitions, runs] = await Promise.all([
        Promise.resolve()
          .then(() => client.workflows.listDefinitions({ workspaceId }))
          .catch(() => []),
        Promise.resolve()
          .then(() => client.workflows.listRuns({ workspaceId }))
          .catch(() => []),
      ]);
      if (this.disposed) return;
      this.setWorkspaceData(workspaceId, definitions, runs, false, null);
    } catch (error) {
      if (this.disposed) return;
      this.updateWorkspaceLoading(
        workspaceId,
        false,
        error instanceof Error ? error.message : "Failed to load workflows"
      );
    } finally {
      this.inFlightSnapshots.delete(workspaceId);
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
    }, WORKFLOW_RUN_POLL_INTERVAL_MS);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
    this.runTimers.set(key, timer);
  }

  private async pollRun(workspaceId: string, runId: string): Promise<void> {
    if (this.client == null || this.disposed || !this.listenersByWorkspace.has(workspaceId)) return;
    const run = await this.client.workflows.getRun({ workspaceId, runId });
    if (this.disposed || !this.listenersByWorkspace.has(workspaceId) || run == null) return;

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

  private emit(workspaceId: string): void {
    const listeners = this.listenersByWorkspace.get(workspaceId);
    if (listeners == null) return;
    for (const listener of listeners) listener();
  }
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

  return useSyncExternalStore(
    (listener) => (workspaceId ? store.subscribeWorkspace(workspaceId, listener) : () => undefined),
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

  return useSyncExternalStore(
    (listener) => (workspaceId ? store.subscribeWorkspace(workspaceId, listener) : () => undefined),
    () => store.getWorkspaceSnapshot(workspaceId),
    () => EMPTY_SNAPSHOT
  );
}
