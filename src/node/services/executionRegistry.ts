import { createHash } from "node:crypto";

import {
  EXECUTION_HANDLE_VERSION,
  type ExecutionHandle,
  type ExecutionResult,
  type ExecutionStatus,
} from "@/common/types/execution";
import { resolveBackgroundWorkAttentionPolicy } from "@/common/types/backgroundWorkAttention";
import type { Workspace } from "@/common/types/project";
import type { Config } from "@/node/config";
import { ExecutionStore } from "@/node/services/executionStore";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import {
  TaskHandleStore,
  isWorkspaceTurnTaskId,
  type WorkspaceTurnTaskHandleRecord,
} from "@/node/services/taskHandleStore";
import {
  readSubagentFailureArtifact,
  readSubagentFailureArtifactsFile,
  type SubagentFailureArtifact,
} from "@/node/services/subagentFailureArtifacts";
import { readSubagentGitPatchArtifact } from "@/node/services/subagentGitPatchArtifacts";
import {
  readSubagentReportArtifact,
  readSubagentReportArtifactsFile,
  type SubagentReportArtifact,
} from "@/node/services/subagentReportArtifacts";

const EPOCH_ISO = new Date(0).toISOString();

type LegacyExecutionKind = "agent_task" | "workspace_turn";

function legacyExecutionId(kind: LegacyExecutionKind, sourceId: string): `exe_${string}` {
  const digest = createHash("sha256").update(`${kind}\0${sourceId}`).digest("hex").slice(0, 24);
  return `exe_legacy_${kind}_${digest}`;
}

function validIso(value: string | undefined): string | undefined {
  if (value == null || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function msToIso(value: number | undefined): string | undefined {
  return value != null && Number.isFinite(value) ? new Date(value).toISOString() : undefined;
}

function terminalAt(status: ExecutionStatus, value: string): string | undefined {
  return status === "completed" || status === "interrupted" || status === "error"
    ? value
    : undefined;
}

type ExecutionWaiter = (handle: ExecutionHandle) => void;

export type ExecutionWaitResult =
  | { kind: "terminal"; handle: ExecutionHandle }
  | { kind: "timeout"; snapshot: ExecutionHandle }
  | { kind: "aborted"; snapshot: ExecutionHandle }
  | { kind: "not_found" };

function isTerminalExecution(handle: ExecutionHandle): boolean {
  return (
    handle.status === "completed" || handle.status === "interrupted" || handle.status === "error"
  );
}

function executionStatusForResult(
  result: ExecutionResult
): Extract<ExecutionStatus, "completed" | "interrupted" | "error"> {
  return result.kind;
}

/**
 * Read-through registry for canonical handles plus legacy task persistence.
 * Legacy sources are adapted in memory and never eagerly rewritten.
 */
export class ExecutionRegistry {
  private readonly executionStore: ExecutionStore;
  private readonly taskHandleStore: TaskHandleStore;
  private readonly settlementLocks = new MutexMap<string>();
  private readonly terminalWaiters = new Map<string, Set<ExecutionWaiter>>();

  constructor(
    private readonly config: Config,
    dependencies: {
      executionStore?: ExecutionStore;
      taskHandleStore?: TaskHandleStore;
    } = {}
  ) {
    this.executionStore = dependencies.executionStore ?? new ExecutionStore(config);
    this.taskHandleStore = dependencies.taskHandleStore ?? new TaskHandleStore(config);
  }

  /** Read the latest canonical or legacy-adapted handle without registering a waiter. */
  async snapshot(
    ownerSessionId: string,
    executionIdOrAlias: string
  ): Promise<ExecutionHandle | null> {
    const canonical = await this.getCanonical(ownerSessionId, executionIdOrAlias);
    if (canonical != null) return canonical;

    if (isWorkspaceTurnTaskId(executionIdOrAlias)) {
      const workspaceTurn = await this.taskHandleStore.getWorkspaceTurn(
        ownerSessionId,
        executionIdOrAlias
      );
      if (workspaceTurn != null) return this.adaptWorkspaceTurn(workspaceTurn);
    }

    const legacyAgent = await this.readLegacyAgentTask(ownerSessionId, executionIdOrAlias);
    if (legacyAgent != null) return legacyAgent;

    const legacy = await this.listLegacy(ownerSessionId);
    return legacy.find((handle) => handle.executionId === executionIdOrAlias) ?? null;
  }

  async get(ownerSessionId: string, executionIdOrAlias: string): Promise<ExecutionHandle | null> {
    return await this.snapshot(ownerSessionId, executionIdOrAlias);
  }

  /** Persist a canonical creation/update and publish a terminal handle only after the write succeeds. */
  async upsert(handle: ExecutionHandle): Promise<ExecutionHandle> {
    const key = this.executionKey(handle.ownerSessionId, handle.executionId);
    return await this.settlementLocks.withLock(key, async () => {
      const current = await this.executionStore.get(handle.ownerSessionId, handle.executionId);
      if (current != null && isTerminalExecution(current)) return current;

      await this.executionStore.upsert(handle);
      if (isTerminalExecution(handle)) this.resolveTerminalWaiters(key, handle);
      return handle;
    });
  }

  /**
   * Replace canonical state from a restart-durable compatibility shadow.
   *
   * Normal lifecycle writes remain first-terminal-wins through `upsert`/`settle`. Reconciliation
   * is deliberately stronger because the workspace-turn shadow can prove that a stale terminal
   * projection was revived or repaired after its child workspace self-healed.
   */
  async overwriteForReconciliation(handle: ExecutionHandle): Promise<ExecutionHandle> {
    const key = this.executionKey(handle.ownerSessionId, handle.executionId);
    return await this.settlementLocks.withLock(key, async () => {
      await this.executionStore.upsert(handle);
      if (isTerminalExecution(handle)) this.resolveTerminalWaiters(key, handle);
      return handle;
    });
  }

  /**
   * Atomically persist the first terminal result for a canonical execution. Later settlements are
   * idempotent and return the immutable persisted terminal handle.
   */
  async settle(
    ownerSessionId: string,
    executionIdOrAlias: string,
    result: ExecutionResult,
    options: { terminalAt?: string } = {}
  ): Promise<ExecutionHandle | null> {
    const canonical = await this.getCanonical(ownerSessionId, executionIdOrAlias);
    if (canonical == null) return null;

    const key = this.executionKey(ownerSessionId, canonical.executionId);
    return await this.settlementLocks.withLock(key, async () => {
      const current = await this.executionStore.get(ownerSessionId, canonical.executionId);
      if (current == null) return null;
      if (isTerminalExecution(current)) return current;

      const terminalAt = options.terminalAt ?? new Date().toISOString();
      const terminal: ExecutionHandle = {
        ...current,
        status: executionStatusForResult(result),
        phase: undefined,
        result,
        updatedAt: terminalAt,
        terminalAt,
      };
      await this.executionStore.upsert(terminal);
      // Awaiters must never observe a result that is not already restart-durable.
      this.resolveTerminalWaiters(key, terminal);
      return terminal;
    });
  }

  /** Wait for canonical terminal settlement, resolving aliases before registering the waiter. */
  async waitForTerminal(
    ownerSessionId: string,
    executionIdOrAlias: string,
    options: { timeoutMs?: number; abortSignal?: AbortSignal } = {}
  ): Promise<ExecutionWaitResult> {
    const canonical = await this.getCanonical(ownerSessionId, executionIdOrAlias);
    if (canonical == null) return { kind: "not_found" };
    if (isTerminalExecution(canonical)) return { kind: "terminal", handle: canonical };

    const key = this.executionKey(ownerSessionId, canonical.executionId);
    let waiter: ExecutionWaiter | undefined;
    const registration = await this.settlementLocks.withLock(key, async () => {
      const current = await this.executionStore.get(ownerSessionId, canonical.executionId);
      if (current == null) return { kind: "not_found" as const };
      if (isTerminalExecution(current)) return { kind: "terminal" as const, handle: current };

      const pending = new Promise<ExecutionHandle>((resolve) => {
        waiter = resolve;
        const waiters = this.terminalWaiters.get(key) ?? new Set<ExecutionWaiter>();
        waiters.add(resolve);
        this.terminalWaiters.set(key, waiters);
      });
      return { kind: "pending" as const, pending };
    });
    if (registration.kind === "not_found") return registration;
    if (registration.kind === "terminal") return registration;

    const outcome = await raceWithAbortAndTimeout(registration.pending, {
      timeoutMs: options.timeoutMs,
      signal: options.abortSignal,
    });
    if (waiter != null) this.removeTerminalWaiter(key, waiter);
    if (outcome.kind === "ok") return { kind: "terminal", handle: outcome.value };

    const latest = await this.executionStore.get(ownerSessionId, canonical.executionId);
    if (latest == null) return { kind: "not_found" };
    if (isTerminalExecution(latest)) return { kind: "terminal", handle: latest };
    return outcome.kind === "timeout"
      ? { kind: "timeout", snapshot: latest }
      : { kind: "aborted", snapshot: latest };
  }

  async list(ownerSessionId: string): Promise<ExecutionHandle[]> {
    const canonical = await this.executionStore.list(ownerSessionId);
    const claimedIds = new Set(
      canonical.flatMap((handle) => [handle.executionId, ...(handle.aliases ?? [])])
    );
    const legacy = (await this.listLegacy(ownerSessionId)).filter(
      (handle) =>
        !claimedIds.has(handle.executionId) &&
        !(handle.aliases ?? []).some((alias) => claimedIds.has(alias))
    );
    return [...canonical, ...legacy].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.executionId.localeCompare(b.executionId)
    );
  }

  private async getCanonical(
    ownerSessionId: string,
    executionIdOrAlias: string
  ): Promise<ExecutionHandle | null> {
    const direct = await this.executionStore.get(ownerSessionId, executionIdOrAlias);
    if (direct != null) return direct;

    const canonical = await this.executionStore.list(ownerSessionId);
    return canonical.find((handle) => handle.aliases?.includes(executionIdOrAlias)) ?? null;
  }

  private executionKey(ownerSessionId: string, executionId: string): string {
    return `${ownerSessionId}\0${executionId}`;
  }

  private resolveTerminalWaiters(key: string, handle: ExecutionHandle): void {
    const waiters = this.terminalWaiters.get(key);
    this.terminalWaiters.delete(key);
    for (const resolve of waiters ?? []) resolve(handle);
  }

  private removeTerminalWaiter(key: string, waiter: ExecutionWaiter): void {
    const waiters = this.terminalWaiters.get(key);
    if (waiters == null) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.terminalWaiters.delete(key);
  }

  private async listLegacy(ownerSessionId: string): Promise<ExecutionHandle[]> {
    const workspaceTurns = await this.taskHandleStore.listWorkspaceTurns(ownerSessionId);
    const agentTasks = await this.listLegacyAgentTasks(ownerSessionId);
    return [...workspaceTurns.map((record) => this.adaptWorkspaceTurn(record)), ...agentTasks];
  }

  private adaptWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): ExecutionHandle {
    const createdAt = validIso(record.createdAt) ?? EPOCH_ISO;
    const updatedAt = validIso(record.updatedAt) ?? createdAt;
    const status = record.status;
    let result: ExecutionResult | undefined;
    if (status === "completed") {
      result = {
        kind: "completed",
        reportMarkdown: record.reportMarkdown ?? "",
        ...(record.finalMessageRef != null ? { finalMessageRef: record.finalMessageRef } : {}),
        ...(record.artifacts != null ? { artifacts: record.artifacts } : {}),
      };
    } else if (status === "interrupted") {
      result = {
        kind: "interrupted",
        ...(record.error != null ? { message: record.error } : {}),
      };
    } else if (status === "error") {
      result = { kind: "error", error: record.error ?? "Workspace turn failed" };
    }

    return {
      version: EXECUTION_HANDLE_VERSION,
      executionId: legacyExecutionId("workspace_turn", record.handleId),
      aliases: [record.handleId],
      ownerSessionId: record.ownerWorkspaceId,
      requesterWorkspaceId: record.ownerWorkspaceId,
      target: {
        kind: "workspace",
        workspaceId: record.workspaceId,
        origin: record.createdWorkspace ? "created" : "existing",
      },
      launchPolicy: {
        kind: "workspace_turn",
        turnId: record.turnId,
        ...(record.title != null ? { title: record.title } : {}),
        ...(record.prompt != null ? { prompt: record.prompt } : {}),
      },
      completionPolicy: { kind: "final_assistant_message" },
      retentionPolicy: {
        kind: record.disposableWorkspace ? "delete_workspace_on_completion" : "retain_workspace",
      },
      attentionPolicy: resolveBackgroundWorkAttentionPolicy(record.attentionPolicy),
      status,
      ...(result != null ? { result } : {}),
      createdAt,
      updatedAt,
      ...(status === "running" ? { startedAt: createdAt } : {}),
      ...(terminalAt(status, updatedAt) != null ? { terminalAt: updatedAt } : {}),
      ...(validIso(record.terminalAttentionNotifiedAt) != null
        ? { terminalAttentionNotifiedAt: validIso(record.terminalAttentionNotifiedAt) }
        : {}),
    };
  }

  private getLegacyAgentWorkspaces(ownerSessionId: string): Map<string, Workspace> {
    const allById = new Map<string, Workspace>();
    const config = this.config.loadConfigOrDefault();
    for (const project of config.projects.values()) {
      for (const workspace of project.workspaces) {
        if (workspace.id != null) allById.set(workspace.id, workspace);
      }
    }

    const descendants = new Map<string, Workspace>();
    for (const [workspaceId, workspace] of allById) {
      let current = workspace;
      const visited = new Set<string>();
      while (current.parentWorkspaceId != null && !visited.has(current.parentWorkspaceId)) {
        if (current.parentWorkspaceId === ownerSessionId) {
          descendants.set(workspaceId, workspace);
          break;
        }
        visited.add(current.parentWorkspaceId);
        const parent = allById.get(current.parentWorkspaceId);
        if (parent == null) break;
        current = parent;
      }
    }
    return descendants;
  }

  private async listLegacyAgentTasks(ownerSessionId: string): Promise<ExecutionHandle[]> {
    const sessionDir = this.config.getSessionDir(ownerSessionId);
    const [reports, failures] = await Promise.all([
      readSubagentReportArtifactsFile(sessionDir),
      readSubagentFailureArtifactsFile(sessionDir),
    ]);
    const workspaces = this.getLegacyAgentWorkspaces(ownerSessionId);
    const taskIds = new Set([
      ...workspaces.keys(),
      ...Object.keys(reports.artifactsByChildTaskId),
      ...Object.keys(failures.failuresByChildTaskId),
    ]);
    const records = await Promise.all(
      [...taskIds].map((taskId) => this.readLegacyAgentTask(ownerSessionId, taskId, workspaces))
    );
    return records.filter((record): record is ExecutionHandle => record != null);
  }

  private async readLegacyAgentTask(
    ownerSessionId: string,
    taskId: string,
    knownWorkspaces = this.getLegacyAgentWorkspaces(ownerSessionId)
  ): Promise<ExecutionHandle | null> {
    const sessionDir = this.config.getSessionDir(ownerSessionId);
    const workspace = knownWorkspaces.get(taskId);
    const [report, failure] = await Promise.all([
      readSubagentReportArtifact(sessionDir, taskId),
      readSubagentFailureArtifact(sessionDir, taskId),
    ]);
    if (
      workspace == null &&
      report?.parentWorkspaceId !== ownerSessionId &&
      failure?.parentWorkspaceId !== ownerSessionId
    ) {
      return null;
    }
    const patch = await readSubagentGitPatchArtifact(sessionDir, taskId);
    return this.adaptAgentTask(ownerSessionId, taskId, workspace, report, failure, patch);
  }

  private adaptAgentTask(
    ownerSessionId: string,
    taskId: string,
    workspace: Workspace | undefined,
    report: SubagentReportArtifact | null,
    failure: SubagentFailureArtifact | null,
    patch: Awaited<ReturnType<typeof readSubagentGitPatchArtifact>>
  ): ExecutionHandle {
    let status: ExecutionStatus;
    let phase: "awaiting_report" | undefined;
    let result: ExecutionResult | undefined;
    if (report != null) {
      status = "completed";
      result = {
        kind: "completed",
        reportMarkdown: report.reportMarkdown,
        ...(report.structuredOutput !== undefined
          ? { structuredOutput: report.structuredOutput }
          : {}),
        ...(patch != null ? { artifacts: { gitFormatPatch: patch } } : {}),
      };
    } else if (failure != null || workspace?.taskLaunchError != null) {
      status = "error";
      result = {
        kind: "error",
        error: failure?.errorMessage ?? workspace?.taskLaunchError ?? "Agent task failed",
        ...(failure?.errorType != null ? { errorType: failure.errorType } : {}),
      };
    } else if (workspace?.taskStatus === "reported") {
      status = "completed";
      result = { kind: "completed", reportMarkdown: "" };
    } else if (workspace?.taskStatus === "interrupted") {
      status = "interrupted";
      result = { kind: "interrupted" };
    } else if (workspace?.taskStatus === "queued" || workspace?.taskStatus === "starting") {
      status = workspace.taskStatus;
    } else {
      status = "running";
      if (workspace?.taskStatus === "awaiting_report") phase = "awaiting_report";
    }

    const createdAt =
      validIso(workspace?.createdAt) ??
      msToIso(report?.createdAtMs) ??
      msToIso(failure?.createdAtMs) ??
      EPOCH_ISO;
    const updatedAt =
      validIso(workspace?.reportedAt) ??
      msToIso(report?.updatedAtMs) ??
      msToIso(failure?.updatedAtMs) ??
      createdAt;
    const title = workspace?.title ?? report?.title;
    const agentId = workspace?.agentId ?? workspace?.agentType;

    return {
      version: EXECUTION_HANDLE_VERSION,
      executionId: legacyExecutionId("agent_task", taskId),
      aliases: [taskId],
      ownerSessionId,
      requesterWorkspaceId: workspace?.parentWorkspaceId ?? ownerSessionId,
      ...(workspace?.parentWorkspaceId != null && workspace.parentWorkspaceId !== ownerSessionId
        ? { parentExecutionId: legacyExecutionId("agent_task", workspace.parentWorkspaceId) }
        : {}),
      target: { kind: "workspace", workspaceId: taskId, origin: "created" },
      launchPolicy: {
        kind: "agent_task",
        ...(agentId != null ? { agentId } : {}),
        ...(title != null ? { title } : {}),
        ...(workspace?.taskPrompt != null ? { prompt: workspace.taskPrompt } : {}),
      },
      completionPolicy: { kind: "final_assistant_message" },
      retentionPolicy: { kind: "delete_workspace_on_completion" },
      attentionPolicy: resolveBackgroundWorkAttentionPolicy(workspace?.taskAttentionPolicy),
      status,
      ...(phase != null ? { phase } : {}),
      ...(result != null ? { result } : {}),
      createdAt,
      updatedAt,
      ...(status === "running" ? { startedAt: createdAt } : {}),
      ...(terminalAt(status, updatedAt) != null ? { terminalAt: updatedAt } : {}),
    };
  }
}
