import * as crypto from "node:crypto";

import type {
  WorkflowActionDescriptor,
  WorkflowDefinitionDescriptor,
  WorkflowRunRecord,
  WorkflowRunStatus,
} from "@/common/types/workflow";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { getWorkflowCheckpointRetryEligibility } from "@/common/utils/workflowRetryEligibility";
import type { IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import { WORKFLOW_RUN_TASK_ID_PREFIX } from "@/node/services/tools/taskId";
import type { WorkflowActionRegistry } from "./WorkflowActionRegistry";
import { WorkflowActionRunner } from "./WorkflowActionRunner";
import type {
  WorkflowDefinitionStore,
  WorkflowDefinitionReadResult,
  WorkflowDefinitionSummary,
  WorkflowPromotionLocation,
} from "./WorkflowDefinitionStore";
import type { WorkflowRunStore } from "./WorkflowRunStore";
import {
  WorkflowRunBackgroundedError,
  WorkflowRunner,
  type WorkflowChildRunAdapter,
  type WorkflowRunnerClock,
  type WorkflowRunnerRunOptions,
  type WorkflowTaskAdapter,
} from "./WorkflowRunner";
import { normalizeWorkflowArgsForSource } from "./workflowArgs";
import { MAX_NESTED_WORKFLOW_DEPTH } from "./nestedWorkflowRuns";

export interface WorkflowBackgroundRunTerminalEvent {
  runId: string;
  status: WorkflowRunStatus;
  result: unknown;
  run: WorkflowRunRecord;
}

export interface WorkflowServiceOptions {
  definitionStore: WorkflowDefinitionStore;
  runStore: WorkflowRunStore;
  actionRegistry?: WorkflowActionRegistry;
  actionRunner?: WorkflowActionRunner;
  defaultActionCwd?: string;
  runtimeFactory: IJSRuntimeFactory;
  taskAdapter?: WorkflowTaskAdapter;
  /** workflowName is the human-readable definition name, used to label spawned tasks. */
  taskAdapterFactory?: (runId: string, workflowName?: string) => WorkflowTaskAdapter;
  onBackgroundRunTerminal?: (event: WorkflowBackgroundRunTerminalEvent) => Promise<void> | void;
  /** When true, background terminal notifications also fire for interrupted runs. */
  notifyInterruptedBackgroundRunTerminal?: boolean;
  generateRunId?: () => string;
  // Delayed crash-recovery retries must use current trust, not the value captured when scheduled.
  getCurrentProjectTrusted?: () => boolean | Promise<boolean>;
  /** Stable prefix; WorkflowService appends run identity and a nonce for each lease owner. */
  runnerId: string;
  clock?: WorkflowRunnerClock;
}

export interface WorkflowRunCreatedEvent {
  runId: string;
  status: "pending";
  result: null;
  run: WorkflowRunRecord;
}

export interface WorkflowBackgroundRunCreatedEvent {
  runId: string;
  status: "running";
  result: null;
  run: WorkflowRunRecord;
}

export interface StartNamedWorkflowInput {
  name: string;
  workspaceId: string;
  projectTrusted: boolean;
  args: unknown;
  /** Server-resolved invocation context; applied only to schema-declared args that callers omit. */
  defaultArgs?: Record<string, unknown>;
  /** Called after the durable run record exists but before the foreground runner can block. */
  onRunCreated?: (event: WorkflowRunCreatedEvent) => Promise<void> | void;
  onBackgroundRunCreated?: (event: WorkflowBackgroundRunCreatedEvent) => Promise<void> | void;
  abortSignal?: AbortSignal;
  backgroundOnMessageQueued?: boolean;
}

export interface PromoteScratchDefinitionInput {
  workspaceId: string;
  name: string;
  description: string;
  location: WorkflowPromotionLocation;
  overwrite: boolean;
  projectTrusted: boolean;
}

export interface PromoteScratchWorkflowInput {
  workspaceId: string;
  runId: string;
  name: string;
  description: string;
  location: WorkflowPromotionLocation;
  overwrite: boolean;
  projectTrusted: boolean;
}

export interface StartNamedWorkflowResult {
  runId: string;
  status: WorkflowRunStatus;
  result: unknown;
}

const CHILD_WORKFLOW_ACTIVE_POLL_MS = 1_000;

const WORKFLOW_BACKGROUND_CONTINUATION_STATUSES = new Set<WorkflowRunStatus>([
  "completed",
  "failed",
]);

// oRPC creates a WorkflowService per request, so workflow lifecycle state that spans requests
// needs process-wide registries.
const pendingCrashResumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeWorkflowInterruptStatusWrites = new Map<string, Promise<void>>();
const activeWorkflowRunnerAbortControllers = new Map<string, AbortController>();

export class WorkflowService {
  private readonly definitionStore: WorkflowDefinitionStore;
  private readonly runStore: WorkflowRunStore;
  private readonly actionRegistry?: WorkflowActionRegistry;
  private readonly actionRunner: WorkflowActionRunner;
  private readonly defaultActionCwd?: string;
  private readonly runtimeFactory: IJSRuntimeFactory;
  private readonly taskAdapter?: WorkflowTaskAdapter;
  private readonly taskAdapterFactory?: (
    runId: string,
    workflowName?: string
  ) => WorkflowTaskAdapter;
  private readonly onBackgroundRunTerminal?: (
    event: WorkflowBackgroundRunTerminalEvent
  ) => Promise<void> | void;
  private readonly notifyInterruptedBackgroundRunTerminal: boolean;
  private readonly generateRunId: () => string;
  private readonly getCurrentProjectTrusted?: () => boolean | Promise<boolean>;
  private readonly runnerId: string;
  private readonly clock?: WorkflowRunnerClock;

  private readonly backgroundRuns = new Set<Promise<void>>();

  constructor(options: WorkflowServiceOptions) {
    assert(options.runnerId.length > 0, "WorkflowService: runnerId is required");
    this.definitionStore = options.definitionStore;
    this.runStore = options.runStore;
    this.actionRegistry = options.actionRegistry;
    this.actionRunner = options.actionRunner ?? new WorkflowActionRunner();
    this.defaultActionCwd = options.defaultActionCwd;
    this.runtimeFactory = options.runtimeFactory;
    assert(
      options.taskAdapter != null || options.taskAdapterFactory != null,
      "WorkflowService: taskAdapter or taskAdapterFactory is required"
    );
    this.taskAdapter = options.taskAdapter;
    this.taskAdapterFactory = options.taskAdapterFactory;
    this.onBackgroundRunTerminal = options.onBackgroundRunTerminal;
    this.notifyInterruptedBackgroundRunTerminal =
      options.notifyInterruptedBackgroundRunTerminal === true;
    this.generateRunId = options.generateRunId ?? generateWorkflowRunId;
    this.getCurrentProjectTrusted = options.getCurrentProjectTrusted;
    this.runnerId = options.runnerId;
    this.clock = options.clock;
  }

  async listDefinitions(options: {
    projectTrusted: boolean;
  }): Promise<WorkflowDefinitionDescriptor[]> {
    return await this.definitionStore.listDefinitions(options);
  }

  async listActions(options: { projectTrusted: boolean }): Promise<WorkflowActionDescriptor[]> {
    const registry = this.actionRegistry;
    if (registry == null) {
      return [];
    }

    const actions = await registry.listActions(options);
    const descriptors: WorkflowActionDescriptor[] = [];
    for (const action of actions) {
      try {
        const resolvedAction = await registry.resolveAction(action.name, options);
        const description = await this.actionRunner.describe(resolvedAction);
        descriptors.push({
          name: resolvedAction.name,
          scope: resolvedAction.scope,
          sourcePath: resolvedAction.sourcePath,
          executable: true,
          metadata: description.metadata,
          hasReconcile: description.hasReconcile,
        });
      } catch (error) {
        descriptors.push({
          name: action.name,
          scope: action.scope,
          sourcePath: action.sourcePath,
          executable: false,
          blockedReason: getErrorMessage(error),
        });
      }
    }
    return descriptors;
  }

  async listDefinitionsWithMetadata(options: {
    projectTrusted: boolean;
  }): Promise<WorkflowDefinitionSummary[]> {
    return await this.definitionStore.listDefinitionsWithMetadata(options);
  }

  async readDefinition(input: {
    name: string;
    projectTrusted: boolean;
  }): Promise<WorkflowDefinitionReadResult> {
    return await this.definitionStore.readDefinition(input.name, {
      projectTrusted: input.projectTrusted,
    });
  }

  async listRuns(input: { workspaceId: string }): Promise<WorkflowRunRecord[]> {
    assert(input.workspaceId.length > 0, "WorkflowService.listRuns: workspaceId is required");
    const runs = await this.runStore.listRuns();
    return runs.filter(
      (run) => run.workspaceId === input.workspaceId && run.parentWorkflow == null
    );
  }

  async resumeCrashedRuns(input: {
    workspaceId: string;
    projectTrusted: boolean;
  }): Promise<string[]> {
    assert(
      input.workspaceId.length > 0,
      "WorkflowService.resumeCrashedRuns: workspaceId is required"
    );
    const runs = await this.listRuns({ workspaceId: input.workspaceId });
    const resumable = runs.filter(
      (run) => run.status === "running" || run.status === "backgrounded"
    );
    const resumedRunIds: string[] = [];
    for (const run of resumable) {
      if (
        await this.resumeCrashRecoveredRun({
          runId: run.id,
          projectTrusted: input.projectTrusted,
          failureMessage: "Auto-resumed workflow run failed:",
        })
      ) {
        resumedRunIds.push(run.id);
      }
    }
    return resumedRunIds;
  }

  async getRun(input: { workspaceId: string; runId: string }): Promise<WorkflowRunRecord | null> {
    assert(input.workspaceId.length > 0, "WorkflowService.getRun: workspaceId is required");
    assert(input.runId.length > 0, "WorkflowService.getRun: runId is required");
    try {
      const run = await this.runStore.getRun(input.runId);
      return run.workspaceId === input.workspaceId ? run : null;
    } catch {
      return null;
    }
  }

  async interruptRun(input: { workspaceId: string; runId: string }): Promise<WorkflowRunRecord> {
    const run = await this.requireRunForWorkspace(input);
    assertWorkflowRunCanTransition(run.status, "interrupted");
    const interruptStatusWrite = Promise.withResolvers<void>();
    activeWorkflowInterruptStatusWrites.set(input.runId, interruptStatusWrite.promise);
    let statusWriteSettled = false;
    const settleStatusWrite = () => {
      if (statusWriteSettled) {
        return;
      }
      statusWriteSettled = true;
      interruptStatusWrite.resolve();
    };
    try {
      // Stop the active coordinator only after ownership is validated; child cleanup and status
      // writes can block on I/O, but a mis-scoped request must not abort another workspace's run.
      this.abortActiveRunner(input.runId);
      const interrupted = await this.runStore.appendStatus(
        input.runId,
        "interrupted",
        this.clock?.nowIso() ?? new Date().toISOString()
      );
      settleStatusWrite();
      await this.interruptChildWorkflowRuns(input.runId, input.workspaceId, new Set([input.runId]));
      await (this.taskAdapterFactory?.(input.runId) ?? this.requireTaskAdapter()).interruptRun?.();
      return interrupted;
    } finally {
      settleStatusWrite();
      if (activeWorkflowInterruptStatusWrites.get(input.runId) === interruptStatusWrite.promise) {
        activeWorkflowInterruptStatusWrites.delete(input.runId);
      }
    }
  }

  async retryRunFromCheckpointInBackground(input: {
    workspaceId: string;
    runId: string;
    projectTrusted: boolean;
  }): Promise<StartNamedWorkflowResult> {
    const run = await this.requireRunForWorkspace(input);
    assertRunCanResumeWithCurrentTrust(run, input.projectTrusted);
    assertWorkflowRunCanRetryFromCheckpoint(run);
    await this.runInBackground(input.runId, "Background workflow checkpoint retry failed:", {
      allowRetryFromFailedCheckpoint: true,
      projectTrusted: input.projectTrusted,
    });
    return { runId: input.runId, status: "running", result: null };
  }

  async resumeRunInBackground(input: {
    workspaceId: string;
    runId: string;
    projectTrusted: boolean;
  }): Promise<StartNamedWorkflowResult> {
    const run = await this.requireRunForWorkspace(input);
    assertRunCanResumeWithCurrentTrust(run, input.projectTrusted);
    assertWorkflowRunCanTransition(run.status, "running");
    await this.runInBackground(input.runId, "Background workflow resume failed:", {
      allowResumeFromInterrupted: run.status === "interrupted",
      projectTrusted: input.projectTrusted,
    });
    return { runId: input.runId, status: "running", result: null };
  }

  async resumeRun(input: {
    workspaceId: string;
    runId: string;
    projectTrusted: boolean;
    abortSignal?: AbortSignal;
  }): Promise<StartNamedWorkflowResult> {
    const run = await this.requireRunForWorkspace(input);
    assertRunCanResumeWithCurrentTrust(run, input.projectTrusted);
    assertWorkflowRunCanTransition(run.status, "running");
    return await this.runForegroundWithAbortInterrupt({
      workspaceId: input.workspaceId,
      runId: input.runId,
      projectTrusted: input.projectTrusted,
      abortSignal: input.abortSignal,
      runnerOptions: { allowResumeFromInterrupted: run.status === "interrupted" },
      backgroundedFailureMessage: "Backgrounded workflow resume failed:",
    });
  }

  async retryRunFromCheckpoint(input: {
    workspaceId: string;
    runId: string;
    projectTrusted: boolean;
    abortSignal?: AbortSignal;
  }): Promise<StartNamedWorkflowResult> {
    const run = await this.requireRunForWorkspace(input);
    assertRunCanResumeWithCurrentTrust(run, input.projectTrusted);
    assertWorkflowRunCanRetryFromCheckpoint(run);
    return await this.runForegroundWithAbortInterrupt({
      workspaceId: input.workspaceId,
      runId: input.runId,
      projectTrusted: input.projectTrusted,
      abortSignal: input.abortSignal,
      runnerOptions: { allowRetryFromFailedCheckpoint: true },
      backgroundedFailureMessage: "Backgrounded workflow checkpoint retry failed:",
    });
  }

  /**
   * Shared foreground runner choreography: abort-signal -> interrupt wiring, lease-scoped
   * runner abort registration, and self-backgrounding continuation.
   */
  private async runForegroundWithAbortInterrupt(input: {
    workspaceId: string;
    runId: string;
    projectTrusted: boolean;
    abortSignal?: AbortSignal;
    runnerOptions: Pick<
      WorkflowRunnerRunOptions,
      "allowResumeFromInterrupted" | "allowRetryFromFailedCheckpoint"
    >;
    backgroundedFailureMessage: string;
  }): Promise<StartNamedWorkflowResult> {
    if (isAbortSignalAborted(input.abortSignal)) {
      // The caller was aborted before the runner started; leave the run in its current
      // (still resumable) state instead of churning status transitions.
      throw new Error(`Workflow run interrupted: ${input.runId}`);
    }

    const runnerAbortController = new AbortController();
    let unregisterRunnerAbort: () => void = () => undefined;
    const abortInterrupt = this.interruptRunOnAbort(
      input.workspaceId,
      input.runId,
      input.abortSignal,
      runnerAbortController
    );
    try {
      const runner = await this.createRunner(input.runId, input.projectTrusted);
      const result = await runner.run(input.runId, {
        abortSignal: runnerAbortController.signal,
        onLeaseAcquired: () => {
          unregisterRunnerAbort = this.registerActiveRunnerAbortController(
            input.runId,
            runnerAbortController
          );
        },
        ...input.runnerOptions,
      });
      return { runId: input.runId, status: "completed", result };
    } catch (error) {
      if (error instanceof WorkflowRunBackgroundedError) {
        // The runner durably appended `backgrounded` before throwing, so the continuation
        // needs no resume/retry permission flags. Deliberately do NOT forward
        // `allowResumeFromInterrupted`/`allowRetryFromFailedCheckpoint` here: an
        // `interrupted` status observed by the continuation means someone interrupted the
        // run during the lease handoff, and that interrupt must win instead of being
        // silently reverted back to `running`. Likewise skip the continuation entirely
        // when this call was aborted (interruptRunOnAbort aborts our runner controller and
        // is concurrently transitioning the run to `interrupted`).
        if (!runnerAbortController.signal.aborted) {
          void this.runInBackground(input.runId, input.backgroundedFailureMessage, {
            projectTrusted: input.projectTrusted,
          }).catch(() => undefined);
        }
        return { runId: input.runId, status: "backgrounded", result: null };
      }
      throw error;
    } finally {
      abortInterrupt.remove();
      try {
        await abortInterrupt.wait();
        await this.ensureInterruptedAfterAbort(input.workspaceId, input.runId, input.abortSignal);
      } finally {
        unregisterRunnerAbort();
      }
    }
  }

  async promoteScratchDefinition(
    input: PromoteScratchDefinitionInput
  ): Promise<WorkflowDefinitionDescriptor> {
    assert(
      input.workspaceId.length > 0,
      "WorkflowService.promoteScratchDefinition: workspaceId is required"
    );
    if (!input.projectTrusted) {
      throw new Error("Project trust is required to promote scratch workflow definitions");
    }
    const definition = await this.definitionStore.readDefinition(input.name, {
      projectTrusted: input.projectTrusted,
    });
    if (definition.descriptor.scope !== "scratch") {
      throw new Error("Only scratch workflow definitions can be promoted");
    }
    return await this.definitionStore.promoteDefinition({
      name: input.name,
      description: input.description,
      source: definition.source,
      location: input.location,
      overwrite: input.overwrite,
      projectTrusted: input.projectTrusted,
    });
  }

  async promoteScratchWorkflow(
    input: PromoteScratchWorkflowInput
  ): Promise<WorkflowDefinitionDescriptor> {
    const run = await this.requireRunForWorkspace(input);
    if (run.definition.scope !== "scratch") {
      throw new Error("Only scratch workflow runs can be promoted");
    }
    if (!input.projectTrusted) {
      throw new Error("Project trust is required to promote scratch workflow runs");
    }
    return await this.definitionStore.promoteDefinition({
      name: input.name,
      description: input.description,
      source: run.definitionSource,
      location: input.location,
      overwrite: input.overwrite,
      projectTrusted: input.projectTrusted,
    });
  }

  async startNamedWorkflowInBackground(
    input: StartNamedWorkflowInput
  ): Promise<StartNamedWorkflowResult> {
    const createdRun = await this.createNamedWorkflowRun(input);
    const runId = createdRun.id;
    await input.onRunCreated?.({ runId, status: "pending", result: null, run: createdRun });
    const run = await this.runStore.appendStatus(
      runId,
      "running",
      this.clock?.nowIso() ?? new Date().toISOString()
    );
    await input.onBackgroundRunCreated?.({ runId, status: "running", result: null, run });
    void this.runInBackground(runId, "Background workflow run failed:", {
      projectTrusted: input.projectTrusted,
    }).catch(() => undefined);
    return { runId, status: "running", result: null };
  }

  async startNamedWorkflow(input: StartNamedWorkflowInput): Promise<StartNamedWorkflowResult> {
    const createdRun = await this.createNamedWorkflowRun(input);
    const runId = createdRun.id;
    await input.onRunCreated?.({ runId, status: "pending", result: null, run: createdRun });
    if (isAbortSignalAborted(input.abortSignal)) {
      await this.interruptRun({ workspaceId: input.workspaceId, runId });
      throw new Error(`Workflow run interrupted: ${runId}`);
    }

    const runnerAbortController = new AbortController();
    let unregisterRunnerAbort: () => void = () => undefined;
    const abortInterrupt = this.interruptRunOnAbort(
      input.workspaceId,
      runId,
      input.abortSignal,
      runnerAbortController
    );
    try {
      const runner = await this.createRunner(runId, input.projectTrusted);
      const result = await runner.run(runId, {
        abortSignal: runnerAbortController.signal,
        ...(input.backgroundOnMessageQueued !== undefined
          ? { backgroundOnMessageQueued: input.backgroundOnMessageQueued }
          : {}),
        onLeaseAcquired: () => {
          unregisterRunnerAbort = this.registerActiveRunnerAbortController(
            runId,
            runnerAbortController
          );
        },
      });
      return { runId, status: "completed", result };
    } catch (error) {
      if (error instanceof WorkflowRunBackgroundedError) {
        void this.runInBackground(runId, "Backgrounded workflow run failed:", {
          projectTrusted: input.projectTrusted,
        }).catch(() => undefined);
        return { runId, status: "backgrounded", result: null };
      }
      throw error;
    } finally {
      abortInterrupt.remove();
      await abortInterrupt.wait();
      unregisterRunnerAbort();
    }
  }

  private async resumeCrashRecoveredRun(input: {
    runId: string;
    projectTrusted: boolean;
    failureMessage: string;
  }): Promise<boolean> {
    const projectTrusted = await this.resolveCurrentProjectTrust(input.projectTrusted);
    const run = await this.getCrashRecoverableRun(input.runId);
    if (run == null || !canResumeRunWithCurrentTrust(run, projectTrusted)) {
      return false;
    }

    const retryDelayMs = await this.runStore.getLeaseRetryDelayMs(
      input.runId,
      this.clock?.nowMs() ?? Date.now()
    );
    if (retryDelayMs > 0) {
      this.scheduleCrashResumeRetry(input, retryDelayMs);
      return true;
    }

    try {
      await this.runInBackground(input.runId, input.failureMessage, { projectTrusted });
      return true;
    } catch (error) {
      if (isWorkflowRunAlreadyActiveError(error, input.runId)) {
        const nextRetryDelayMs = await this.runStore.getLeaseRetryDelayMs(
          input.runId,
          this.clock?.nowMs() ?? Date.now()
        );
        this.scheduleCrashResumeRetry(input, Math.max(1, nextRetryDelayMs));
        return true;
      }
      console.error(input.failureMessage, error);
      return false;
    }
  }

  private async resolveCurrentProjectTrust(fallback: boolean): Promise<boolean> {
    return (await this.getCurrentProjectTrusted?.()) ?? fallback;
  }

  private async getCrashRecoverableRun(runId: string): Promise<WorkflowRunRecord | null> {
    try {
      const run = await this.runStore.getRun(runId);
      return run.status === "running" || run.status === "backgrounded" ? run : null;
    } catch {
      return null;
    }
  }

  private scheduleCrashResumeRetry(
    input: { runId: string; projectTrusted: boolean; failureMessage: string },
    delayMs: number
  ): void {
    assert(delayMs > 0, "WorkflowService.scheduleCrashResumeRetry: delayMs must be positive");
    if (pendingCrashResumeTimers.has(input.runId)) {
      return;
    }
    const timer = setTimeout(() => {
      pendingCrashResumeTimers.delete(input.runId);
      void this.resumeCrashRecoveredRun(input).catch((error: unknown) => {
        console.error(input.failureMessage, error);
      });
    }, delayMs);
    unrefTimer(timer);
    pendingCrashResumeTimers.set(input.runId, timer);
  }

  private registerActiveRunnerAbortController(
    runId: string,
    controller: AbortController
  ): () => void {
    assert(runId.length > 0, "WorkflowService.registerActiveRunnerAbortController: runId required");
    const existing = activeWorkflowRunnerAbortControllers.get(runId);
    if (existing != null && existing !== controller) {
      existing.abort();
    }
    activeWorkflowRunnerAbortControllers.set(runId, controller);
    return () => {
      if (activeWorkflowRunnerAbortControllers.get(runId) === controller) {
        activeWorkflowRunnerAbortControllers.delete(runId);
      }
    };
  }

  private abortActiveRunner(runId: string): void {
    activeWorkflowRunnerAbortControllers.get(runId)?.abort();
  }

  private async ensureInterruptedAfterAbort(
    workspaceId: string,
    runId: string,
    callerAbortSignal: AbortSignal | undefined
  ): Promise<void> {
    // Only the caller's abort signal means this resume/retry should preserve an interrupt.
    // The runner controller can also be aborted during legitimate lease handoffs/replacements.
    if (callerAbortSignal?.aborted !== true) {
      return;
    }

    const run = await this.getRun({ workspaceId, runId });
    if (
      run == null ||
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "interrupted"
    ) {
      return;
    }

    await this.interruptRun({ workspaceId, runId });
  }

  private interruptRunOnAbort(
    workspaceId: string,
    runId: string,
    abortSignal: AbortSignal | undefined,
    runnerAbortController: AbortController | undefined
  ): { remove: () => void; wait: () => Promise<void> } {
    if (abortSignal == null) {
      return { remove: () => undefined, wait: () => Promise.resolve() };
    }
    let interruptPromise: Promise<void> | null = null;
    const interrupt = () => {
      // Cancel the coordinator before interrupt side effects can block on task cleanup or disk I/O.
      runnerAbortController?.abort();
      interruptPromise = (async () => {
        try {
          await this.interruptRun({ workspaceId, runId });
        } catch {
          // The run may have completed or failed before the abort event was delivered.
        }
      })();
    };
    abortSignal.addEventListener("abort", interrupt, { once: true });
    return {
      remove: () => abortSignal.removeEventListener("abort", interrupt),
      wait: async () => {
        await interruptPromise;
      },
    };
  }

  private async createNamedWorkflowRun(input: StartNamedWorkflowInput): Promise<WorkflowRunRecord> {
    assert(
      input.workspaceId.length > 0,
      "WorkflowService.createNamedWorkflowRun: workspaceId is required"
    );
    const definition = await this.definitionStore.readDefinition(input.name, {
      projectTrusted: input.projectTrusted,
    });
    const runId = this.generateRunId();
    assert(
      runId.length > 0,
      "WorkflowService.createNamedWorkflowRun: generated run id is required"
    );

    const normalized = normalizeWorkflowArgsForSource(definition.source, input.args, {
      defaultArgs: input.defaultArgs,
    });
    return await this.runStore.createRun({
      id: runId,
      workspaceId: input.workspaceId,
      definition: definition.descriptor,
      definitionSource: definition.source,
      args: normalized.args,
      ...(this.defaultActionCwd != null ? { defaultActionCwd: this.defaultActionCwd } : {}),
      now: this.clock?.nowIso() ?? new Date().toISOString(),
    });
  }

  private async runInBackground(
    runId: string,
    failureMessage: string,
    runnerOptions: Pick<
      WorkflowRunnerRunOptions,
      "allowResumeFromInterrupted" | "allowRetryFromFailedCheckpoint"
    > & {
      projectTrusted: boolean;
    }
  ): Promise<void> {
    const runner = await this.createRunner(runId, runnerOptions.projectTrusted);
    const runnerAbortController = new AbortController();
    let unregisterRunnerAbort: () => void = () => undefined;
    let startedSettled = false;
    let resolveStarted: (() => void) | null = null;
    let rejectStarted: ((error: unknown) => void) | null = null;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const markStarted = () => {
      if (startedSettled) {
        return;
      }
      startedSettled = true;
      assert(resolveStarted != null, "WorkflowService.runInBackground: resolveStarted missing");
      resolveStarted();
    };
    const markStartFailed = (error: unknown) => {
      if (startedSettled) {
        return;
      }
      startedSettled = true;
      assert(rejectStarted != null, "WorkflowService.runInBackground: rejectStarted missing");
      rejectStarted(error);
    };
    const markLeaseAcquired = () => {
      unregisterRunnerAbort = this.registerActiveRunnerAbortController(
        runId,
        runnerAbortController
      );
      markStarted();
    };
    const runPromise = runner
      .run(runId, {
        abortSignal: runnerAbortController.signal,
        onLeaseAcquired: markLeaseAcquired,
        backgroundOnMessageQueued: false,
        ...runnerOptions,
      })
      .then(async (result) => {
        await this.notifyBackgroundRunTerminal(runId, result);
      })
      .catch(async (error: unknown) => {
        const hadStarted = startedSettled;
        markStartFailed(error);
        if (!hadStarted && isWorkflowRunAlreadyActiveError(error, runId)) {
          return;
        }
        if (!(await this.isInterruptedBackgroundRun(runId))) {
          console.error(failureMessage, error);
        }
        await this.notifyBackgroundRunTerminal(runId, null);
      });
    this.backgroundRuns.add(runPromise);
    void runPromise.finally(() => {
      unregisterRunnerAbort();
      this.backgroundRuns.delete(runPromise);
    });
    return started;
  }

  private async isInterruptedBackgroundRun(runId: string): Promise<boolean> {
    assert(runId.length > 0, "WorkflowService.isInterruptedBackgroundRun: runId required");
    // interruptRun aborts the active runner before writing the durable interrupted status so
    // cancellation is prompt; wait for that status write before classifying the background exit.
    await activeWorkflowInterruptStatusWrites.get(runId);
    try {
      const run = await this.runStore.getRun(runId);
      return run.status === "interrupted";
    } catch {
      return false;
    }
  }

  private async notifyBackgroundRunTerminal(runId: string, result: unknown): Promise<void> {
    if (this.onBackgroundRunTerminal == null) {
      return;
    }

    let run: WorkflowRunRecord;
    try {
      run = await this.runStore.getRun(runId);
    } catch (error) {
      console.error("Failed to load terminal workflow run for notification:", error);
      return;
    }

    if (
      !WORKFLOW_BACKGROUND_CONTINUATION_STATUSES.has(run.status) &&
      !(this.notifyInterruptedBackgroundRunTerminal && run.status === "interrupted")
    ) {
      return;
    }

    try {
      await this.onBackgroundRunTerminal({ runId, status: run.status, result, run });
    } catch (error) {
      console.error("Workflow background terminal notification failed:", error);
    }
  }

  private async interruptChildWorkflowRuns(
    parentRunId: string,
    workspaceId: string,
    seenRunIds: Set<string>
  ): Promise<void> {
    const runs = await this.runStore.listRuns();
    const activeChildren = runs.filter(
      (run) =>
        run.workspaceId === workspaceId &&
        run.parentWorkflow?.runId === parentRunId &&
        (isInterruptibleWorkflowRunStatus(run.status) || run.status === "interrupted")
    );
    for (const child of activeChildren) {
      await this.interruptChildWorkflowRun(child, workspaceId, seenRunIds);
    }
  }

  private async interruptChildWorkflowRun(
    child: WorkflowRunRecord,
    workspaceId: string,
    seenRunIds: Set<string>
  ): Promise<void> {
    if (seenRunIds.has(child.id)) {
      return;
    }
    seenRunIds.add(child.id);
    this.abortActiveRunner(child.id);
    const interrupted = await this.appendInterruptedIfActive(child.id);
    if (
      !isInterruptibleWorkflowRunStatus(interrupted.status) &&
      interrupted.status !== "interrupted"
    ) {
      return;
    }
    await this.interruptChildWorkflowRuns(child.id, workspaceId, seenRunIds);
    await (this.taskAdapterFactory?.(child.id) ?? this.requireTaskAdapter()).interruptRun?.();
  }

  private async appendInterruptedIfActive(runId: string): Promise<WorkflowRunRecord> {
    const run = await this.runStore.getRun(runId);
    if (!isInterruptibleWorkflowRunStatus(run.status)) {
      return run;
    }
    try {
      return await this.runStore.appendStatus(
        runId,
        "interrupted",
        this.clock?.nowIso() ?? new Date().toISOString()
      );
    } catch (error) {
      const latest = await this.runStore.getRun(runId);
      if (!isInterruptibleWorkflowRunStatus(latest.status)) {
        return latest;
      }
      throw error;
    }
  }

  private async interruptExistingChildWorkflowRun(
    runId: string
  ): Promise<WorkflowRunRecord | null> {
    const run = await this.getRunIfPresent(runId);
    if (run == null) {
      return null;
    }
    this.abortActiveRunner(runId);
    return await this.appendInterruptedIfActive(runId);
  }

  private async getRunIfPresent(runId: string): Promise<WorkflowRunRecord | null> {
    try {
      return await this.runStore.getRun(runId);
    } catch (error) {
      if (isMissingWorkflowRunError(error)) {
        return null;
      }
      throw error;
    }
  }

  private createChildRunAdapter(projectTrusted: boolean): WorkflowChildRunAdapter {
    return {
      runChildWorkflowToTerminal: async (input) => {
        while (true) {
          const currentProjectTrusted = await this.resolveCurrentProjectTrust(projectTrusted);
          if (isAbortSignalAborted(input.abortSignal)) {
            const interrupted = await this.interruptExistingChildWorkflowRun(input.childRunId);
            return {
              runId: input.childRunId,
              status: interrupted?.status ?? "interrupted",
              result: null,
            };
          }

          await this.ensureChildWorkflowRun({ ...input, projectTrusted: currentProjectTrusted });
          let run = await this.runStore.getRun(input.childRunId);
          if (run.status === "completed") {
            return {
              runId: input.childRunId,
              status: "completed",
              result: getWorkflowRunResult(run),
            };
          }
          if (run.status === "failed") {
            return { runId: input.childRunId, status: "failed", result: getWorkflowRunResult(run) };
          }
          assertRunCanResumeWithCurrentTrust(run, currentProjectTrusted);

          if (isAbortSignalAborted(input.abortSignal)) {
            const interrupted = await this.appendInterruptedIfActive(input.childRunId);
            return { runId: input.childRunId, status: interrupted.status, result: null };
          }

          const retryDelayMs = await this.runStore.getLeaseRetryDelayMs(
            input.childRunId,
            this.clock?.nowMs() ?? Date.now()
          );
          if (retryDelayMs > 0) {
            if (input.backgroundOnMessageQueued !== false) {
              return { runId: input.childRunId, status: "backgrounded", result: null };
            }
            await waitForAbortableDelay(
              Math.min(retryDelayMs, CHILD_WORKFLOW_ACTIVE_POLL_MS),
              input.abortSignal
            );
            continue;
          }

          const runner = await this.createRunner(input.childRunId, currentProjectTrusted);
          const childAbortController = new AbortController();
          const removeParentAbortForwarding = forwardAbortSignal(
            input.abortSignal,
            childAbortController
          );
          let unregisterChildRunnerAbort: () => void = () => undefined;
          try {
            const result = await runner.run(input.childRunId, {
              abortSignal: childAbortController.signal,
              backgroundOnMessageQueued: input.backgroundOnMessageQueued ?? false,
              allowResumeFromInterrupted: run.status === "interrupted",
              onLeaseAcquired: () => {
                unregisterChildRunnerAbort = this.registerActiveRunnerAbortController(
                  input.childRunId,
                  childAbortController
                );
              },
            });
            return { runId: input.childRunId, status: "completed", result };
          } catch (error) {
            if (error instanceof WorkflowRunBackgroundedError) {
              run = await this.runStore.getRun(input.childRunId);
              return { runId: input.childRunId, status: run.status, result: null };
            }
            if (isWorkflowRunAlreadyActiveError(error, input.childRunId)) {
              if (input.backgroundOnMessageQueued !== false) {
                return { runId: input.childRunId, status: "backgrounded", result: null };
              }
              const activeRetryDelayMs = await this.runStore.getLeaseRetryDelayMs(
                input.childRunId,
                this.clock?.nowMs() ?? Date.now()
              );
              await waitForAbortableDelay(
                Math.min(Math.max(1, activeRetryDelayMs), CHILD_WORKFLOW_ACTIVE_POLL_MS),
                input.abortSignal
              );
              continue;
            }
            if (isAbortSignalAborted(input.abortSignal)) {
              const interrupted = await this.appendInterruptedIfActive(input.childRunId);
              return { runId: input.childRunId, status: interrupted.status, result: null };
            }
            const currentRun = await this.getRunIfPresent(input.childRunId);
            if (currentRun?.status === "failed" || currentRun?.status === "interrupted") {
              return {
                runId: input.childRunId,
                status: currentRun.status,
                result: getWorkflowRunResult(currentRun),
              };
            }
            throw error;
          } finally {
            removeParentAbortForwarding();
            unregisterChildRunnerAbort();
          }
        }
      },
    };
  }

  private async ensureChildWorkflowRun(input: {
    parentRunId: string;
    stepId: string;
    inputHash: string;
    childRunId: string;
    name: string;
    args: unknown;
    projectTrusted: boolean;
  }): Promise<void> {
    assert(
      input.parentRunId.length > 0,
      "WorkflowService.ensureChildWorkflowRun: parentRunId required"
    );
    assert(
      input.childRunId.length > 0,
      "WorkflowService.ensureChildWorkflowRun: childRunId required"
    );
    assert(input.stepId.length > 0, "WorkflowService.ensureChildWorkflowRun: stepId required");
    assert(
      input.inputHash.length > 0,
      "WorkflowService.ensureChildWorkflowRun: inputHash required"
    );
    const parent = await this.runStore.getRun(input.parentRunId);
    const depth = (parent.parentWorkflow?.depth ?? -1) + 1;
    assert(
      depth <= MAX_NESTED_WORKFLOW_DEPTH,
      `Nested workflow depth limit exceeded (${MAX_NESTED_WORKFLOW_DEPTH})`
    );

    try {
      const existing = await this.runStore.getRun(input.childRunId);
      assert(
        existing.workspaceId === parent.workspaceId,
        "Child workflow workspace must match parent"
      );
      assert(
        existing.definition.name === input.name,
        "Child workflow name must match existing run"
      );
      assert(
        existing.parentWorkflow?.runId === input.parentRunId &&
          existing.parentWorkflow.stepId === input.stepId &&
          existing.parentWorkflow.inputHash === input.inputHash,
        "Existing child workflow run must match parent replay identity"
      );
      return;
    } catch (error) {
      if (!isMissingWorkflowRunError(error)) {
        throw error;
      }
    }

    const definition = await this.definitionStore.readDefinition(input.name, {
      projectTrusted: input.projectTrusted,
    });
    const normalized = normalizeWorkflowArgsForSource(definition.source, input.args);
    await this.runStore.createRunIfAbsent({
      id: input.childRunId,
      workspaceId: parent.workspaceId,
      definition: definition.descriptor,
      definitionSource: definition.source,
      args: normalized.args,
      ...(parent.defaultActionCwd != null || this.defaultActionCwd != null
        ? { defaultActionCwd: parent.defaultActionCwd ?? this.defaultActionCwd }
        : {}),
      parentWorkflow: {
        runId: input.parentRunId,
        stepId: input.stepId,
        inputHash: input.inputHash,
        depth,
      },
      now: this.clock?.nowIso() ?? new Date().toISOString(),
    });
  }

  private async createRunner(runId: string, projectTrusted: boolean): Promise<WorkflowRunner> {
    // The run record always exists by the time a runner is created (create/resume/retry
    // paths persist it first), so resolve the definition name for task labeling here.
    const workflowName =
      this.taskAdapterFactory != null
        ? (await this.runStore.getRun(runId)).definition.name
        : undefined;
    return new WorkflowRunner({
      runStore: this.runStore,
      runtimeFactory: this.runtimeFactory,
      taskAdapter: this.taskAdapterFactory?.(runId, workflowName) ?? this.requireTaskAdapter(),
      actionRegistry: this.actionRegistry,
      childRunAdapter: this.createChildRunAdapter(projectTrusted),
      actionRunner: this.actionRunner,
      getProjectTrusted: () => this.resolveCurrentProjectTrust(projectTrusted),
      projectTrusted,
      defaultActionCwd: this.defaultActionCwd,
      runnerId: generateWorkflowRunnerOwnerId(this.runnerId, runId),
      ...(this.clock != null ? { clock: this.clock } : {}),
    });
  }

  private async requireRunForWorkspace(input: {
    workspaceId: string;
    runId: string;
  }): Promise<WorkflowRunRecord> {
    assert(input.workspaceId.length > 0, "WorkflowService: workspaceId is required");
    assert(input.runId.length > 0, "WorkflowService: runId is required");
    const run = await this.runStore.getRun(input.runId);
    if (run.workspaceId !== input.workspaceId) {
      throw new Error(`Workflow run not found: ${input.runId}`);
    }
    return run;
  }

  private requireTaskAdapter(): WorkflowTaskAdapter {
    assert(this.taskAdapter != null, "WorkflowService: taskAdapter is required");
    return this.taskAdapter;
  }
}

function isMissingWorkflowRunError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (("code" in error && error.code === "ENOENT") || error.message.includes("ENOENT"))
  );
}

function isWorkflowRunAlreadyActiveError(error: unknown, runId: string): boolean {
  return error instanceof Error && error.message === `Workflow run is already active: ${runId}`;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer !== "object" || timer == null || !("unref" in timer)) {
    return;
  }
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

function forwardAbortSignal(
  abortSignal: AbortSignal | undefined,
  controller: AbortController
): () => void {
  if (abortSignal == null) {
    return () => undefined;
  }
  if (abortSignal.aborted) {
    controller.abort();
    return () => undefined;
  }
  const abort = () => controller.abort();
  abortSignal.addEventListener("abort", abort, { once: true });
  return () => abortSignal.removeEventListener("abort", abort);
}

function isAbortSignalAborted(abortSignal?: AbortSignal): boolean {
  return abortSignal?.aborted === true;
}

function isInterruptibleWorkflowRunStatus(status: WorkflowRunStatus): boolean {
  return status === "pending" || status === "running" || status === "backgrounded";
}

function getWorkflowRunResult(run: WorkflowRunRecord): unknown {
  return run.events.findLast((event) => event.type === "result")?.result ?? null;
}

async function waitForAbortableDelay(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
  assert(delayMs > 0, "WorkflowService.waitForAbortableDelay: delayMs must be positive");
  if (abortSignal?.aborted === true) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    unrefTimer(timer);
    abortSignal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

function canResumeRunWithCurrentTrust(run: WorkflowRunRecord, projectTrusted: boolean): boolean {
  return (
    (run.definition.scope !== "project" && run.definition.scope !== "scratch") || projectTrusted
  );
}

function assertRunCanResumeWithCurrentTrust(run: WorkflowRunRecord, projectTrusted: boolean): void {
  if (!canResumeRunWithCurrentTrust(run, projectTrusted)) {
    throw new Error("Project trust is required to resume project-local or scratch workflow runs");
  }
}

function assertWorkflowRunCanRetryFromCheckpoint(run: WorkflowRunRecord): void {
  const eligibility = getWorkflowCheckpointRetryEligibility(run);
  if (!eligibility.canRetry) {
    throw new Error(eligibility.reason ?? "Workflow run cannot be retried from checkpoint");
  }
}

function assertWorkflowRunCanTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): void {
  if (from === "completed" || from === "failed") {
    throw new Error(`Cannot transition workflow run from ${from} to ${to}`);
  }
}

function generateWorkflowRunnerOwnerId(baseRunnerId: string, runId: string): string {
  assert(baseRunnerId.length > 0, "WorkflowService: base runner id is required");
  assert(runId.length > 0, "WorkflowService: run id is required for runner owner id");
  // Lease ownership must fence individual runner processes, not just the workspace/request that
  // created them, so stale runners cannot renew or release a replacement runner's lease.
  return `${baseRunnerId}:${runId}:${crypto.randomBytes(8).toString("hex")}`;
}

function generateWorkflowRunId(): string {
  return `${WORKFLOW_RUN_TASK_ID_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
}
