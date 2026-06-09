import * as path from "node:path";

import { StructuredTaskOutputSchema, WorkflowResultSchema } from "@/common/orpc/schemas";
import { TaskApplyGitPatchToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import type {
  StructuredTaskOutput,
  WorkflowActionEffect,
  WorkflowActionMetadata,
  WorkflowResult,
  WorkflowRunEvent,
  WorkflowStepRecord,
} from "@/common/types/workflow";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { validateJsonSchemaSubset } from "@/common/utils/jsonSchemaSubset";
import type { IJSRuntime, IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import type { ResolvedWorkflowAction, WorkflowActionRegistry } from "./WorkflowActionRegistry";
import {
  WorkflowActionExecutionError,
  WorkflowActionRunner,
  validateWorkflowActionMetadata,
  type WorkflowActionExecutionResult,
} from "./WorkflowActionRunner";
import type { AppendWorkflowRunEventOptions, WorkflowRunStore } from "./WorkflowRunStore";
import { assertWorkflowStepId, hashWorkflowStepInput } from "./workflowReplayKey";

export class WorkflowRunBackgroundedError extends Error {
  constructor(runId: string) {
    super(`Workflow run backgrounded: ${runId}`);
    this.name = "WorkflowRunBackgroundedError";
  }
}

class WorkflowAgentOutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowAgentOutputValidationError";
  }
}

export interface WorkflowAgentSpec {
  id: string;
  prompt: string;
  title?: string;
  agentId?: string;
  outputSchema?: unknown;
}

export interface WorkflowAgentWaitOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  backgroundOnMessageQueued?: boolean;
}

export type WorkflowAgentResult = StructuredTaskOutput & { taskId: string };

export type WorkflowApplyPatchStatus = "applied" | "conflict" | "failed";

export interface WorkflowApplyPatchSpec {
  id: string;
  sourceTaskId: string;
  target: "parent";
  projectPath?: string;
  threeWay: boolean;
  expectedHeadSha?: string;
  force: boolean;
}

export interface WorkflowApplyPatchResult {
  success: boolean;
  status: WorkflowApplyPatchStatus;
  taskId: string;
  dryRun?: boolean;
  projectResults?: unknown;
  appliedCommits?: unknown;
  headCommitSha?: string;
  conflictPaths?: string[];
  failedPatchSubject?: string;
  error?: string;
  note?: string;
}

export interface WorkflowActionSpec {
  id: string;
  input: unknown;
  timeoutMs?: number;
  cwd?: string;
  builtInOnly?: boolean;
  cache?: boolean;
}

export interface WorkflowActionResult {
  output: unknown;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  artifacts: Array<{ name: string; path: string; sizeBytes: number }>;
  reconciled?: boolean;
}

export interface WorkflowTaskAdapter {
  runAgent(
    spec: WorkflowAgentSpec,
    lifecycle?: { onTaskCreated?: (taskId: string) => Promise<void> | void },
    waitOptions?: WorkflowAgentWaitOptions
  ): Promise<WorkflowAgentResult>;
  createAgentTasks?(
    specs: WorkflowAgentSpec[],
    lifecycle?: { onTaskCreated?: (index: number, taskId: string) => Promise<void> | void }
  ): Promise<Array<{ taskId: string; status: "queued" | "starting" | "running" }>>;
  waitForAgentTask?(
    taskId: string,
    spec: WorkflowAgentSpec,
    waitOptions?: WorkflowAgentWaitOptions
  ): Promise<WorkflowAgentResult>;
  applyPatch?(
    spec: WorkflowApplyPatchSpec,
    options?: { abortSignal?: AbortSignal }
  ): Promise<unknown>;
  interruptRun?(): Promise<void>;
}

export interface WorkflowRunnerRunOptions {
  onLeaseAcquired?: () => void;
  abortSignal?: AbortSignal;
  backgroundOnMessageQueued?: boolean;
  allowResumeFromInterrupted?: boolean;
  allowRetryFromFailedCheckpoint?: boolean;
}

interface WorkflowRunnerLeaseGuard {
  throwIfLost(): void;
}

export interface WorkflowRunnerClock {
  nowIso(): string;
  nowMs(): number;
}

export interface WorkflowRunnerOptions {
  runStore: WorkflowRunStore;
  runtimeFactory: IJSRuntimeFactory;
  taskAdapter: WorkflowTaskAdapter;
  actionRegistry?: WorkflowActionRegistry;
  actionRunner?: WorkflowActionRunner;
  getProjectTrusted?: () => boolean | Promise<boolean>;
  projectTrusted?: boolean;
  defaultActionCwd?: string;
  runnerId: string;
  clock?: WorkflowRunnerClock;
}

const WORKFLOW_AGENT_MAX_ATTEMPTS = 3;

const WORKFLOW_RUNTIME_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function isForegroundWaitBackgroundedError(error: unknown): boolean {
  return error instanceof Error && error.name === "ForegroundWaitBackgroundedError";
}

function createForegroundWaitBackgroundedError(): Error {
  const error = new Error("Workflow foreground wait backgrounded");
  error.name = "ForegroundWaitBackgroundedError";
  return error;
}

function shouldRestartUnrecoverableStartedTask(error: unknown): boolean {
  const message = getErrorMessage(error);
  return message === "Task not found" || message === "Task interrupted";
}

function getTaskTerminalStatusForError(
  error: unknown,
  abortSignal?: AbortSignal
): "failed" | "interrupted" {
  if (abortSignal?.aborted === true || getErrorMessage(error) === "Task interrupted") {
    return "interrupted";
  }
  return "failed";
}

function isRetryableAgentOutputError(error: unknown): boolean {
  return error instanceof WorkflowAgentOutputValidationError;
}

function getTaskIdFromUnknownAgentResult(result: unknown): string | undefined {
  if (result != null && typeof result === "object") {
    const taskId = (result as Record<string, unknown>).taskId;
    if (typeof taskId === "string" && taskId.length > 0) {
      return taskId;
    }
  }
  return undefined;
}

function buildRetryAgentSpec(
  spec: WorkflowAgentSpec,
  attempt: number,
  validationMessage: string
): WorkflowAgentSpec {
  return {
    ...spec,
    prompt:
      `${spec.prompt}\n\n` +
      `Previous workflow attempt ${attempt} failed output validation: ${validationMessage}\n` +
      "Rerun the task from scratch and submit a final report whose structured output satisfies the requested schema. " +
      "In file-backed report mode, rewrite structured-output.json and call agent_report with reportMarkdownPath, structuredOutputPath, and title all set to null.",
  };
}

function abortRuntimeOnSignal(runtime: IJSRuntime, abortSignal?: AbortSignal): () => void {
  if (abortSignal == null) {
    return () => undefined;
  }
  if (abortSignal.aborted) {
    runtime.abort();
    return () => undefined;
  }
  const abortRuntime = () => runtime.abort();
  abortSignal.addEventListener("abort", abortRuntime, { once: true });
  return () => abortSignal.removeEventListener("abort", abortRuntime);
}

function getWorkflowAgentWaitOptions(
  runtime: IJSRuntime,
  options: WorkflowRunnerRunOptions | undefined
): WorkflowAgentWaitOptions {
  return {
    abortSignal: runtime.getAbortSignal(),
    timeoutMs: WORKFLOW_RUNTIME_TIMEOUT_MS,
    backgroundOnMessageQueued: options?.backgroundOnMessageQueued ?? true,
  };
}

const DEFAULT_CLOCK: WorkflowRunnerClock = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

export class WorkflowRunner {
  private readonly runStore: WorkflowRunStore;
  private readonly runtimeFactory: IJSRuntimeFactory;
  private readonly taskAdapter: WorkflowTaskAdapter;
  private readonly actionRegistry?: WorkflowActionRegistry;
  private readonly actionRunner: WorkflowActionRunner;
  private readonly getProjectTrusted: () => boolean | Promise<boolean>;
  private readonly defaultActionCwd?: string;
  private readonly runnerId: string;
  private readonly clock: WorkflowRunnerClock;
  private readonly taskEventMutex = new AsyncMutex();

  constructor(options: WorkflowRunnerOptions) {
    assert(options.runnerId.length > 0, "WorkflowRunner: runnerId is required");
    this.runStore = options.runStore;
    this.runtimeFactory = options.runtimeFactory;
    this.taskAdapter = options.taskAdapter;
    this.actionRegistry = options.actionRegistry;
    this.actionRunner = options.actionRunner ?? new WorkflowActionRunner();
    this.getProjectTrusted = options.getProjectTrusted ?? (() => options.projectTrusted ?? false);
    this.defaultActionCwd = options.defaultActionCwd;
    this.runnerId = options.runnerId;
    this.clock = options.clock ?? DEFAULT_CLOCK;
  }

  async run(runId: string, options?: WorkflowRunnerRunOptions): Promise<WorkflowResult> {
    assert(runId.length > 0, "WorkflowRunner.run: runId is required");
    const leaseAcquired = await this.runStore.acquireLease(
      runId,
      this.runnerId,
      this.clock.nowMs()
    );
    if (!leaseAcquired) {
      throw new Error(`Workflow run is already active: ${runId}`);
    }

    options?.onLeaseAcquired?.();
    let activeRuntime: IJSRuntime | null = null;
    let leaseLostError: Error | null = null;
    const markLeaseLost = (cause?: unknown) => {
      leaseLostError ??= new Error(
        cause instanceof Error
          ? `Workflow run lease lost: ${runId}: ${cause.message}`
          : `Workflow run lease lost: ${runId}`
      );
      activeRuntime?.abort();
    };
    const leaseGuard: WorkflowRunnerLeaseGuard = {
      throwIfLost() {
        if (leaseLostError != null) {
          throw leaseLostError;
        }
      },
    };
    let leaseRenewalInFlight = false;
    const leaseRenewal = setInterval(() => {
      if (leaseRenewalInFlight) {
        return;
      }
      leaseRenewalInFlight = true;
      void this.runStore
        .renewLease(runId, this.runnerId, this.clock.nowMs())
        .then((renewed) => {
          if (!renewed) {
            markLeaseLost();
          }
        })
        .catch(markLeaseLost)
        .finally(() => {
          leaseRenewalInFlight = false;
        });
    }, this.runStore.getLeaseRenewalIntervalMs());

    let removeAbortListener: () => void = () => undefined;
    try {
      const run = await this.runStore.getRun(runId);
      const sequence = new WorkflowEventSequence(run.events.at(-1)?.sequence ?? 0);
      if (run.status === "completed") {
        const completedResult = run.events.findLast((event) => event.type === "result")?.result;
        if (completedResult != null) {
          return completedResult;
        }
      }
      const resumingInterruptedRun = run.status === "interrupted";
      const retryingFailedRun = run.status === "failed";
      if (resumingInterruptedRun && options?.allowResumeFromInterrupted !== true) {
        throw new Error(`Workflow run interrupted: ${runId}`);
      }
      if (retryingFailedRun && options?.allowRetryFromFailedCheckpoint !== true) {
        throw new Error(`Workflow run failed: ${runId}`);
      }
      const ignoreStartedTaskIds = resumingInterruptedRun;
      let backgrounded: Promise<void> | null = null;
      const markBackgrounded = async () => {
        leaseGuard.throwIfLost();
        backgrounded ??= this.appendEvent(runId, {
          sequence: sequence.next(),
          type: "status",
          at: this.clock.nowIso(),
          status: "backgrounded",
        }).then(() => undefined);
        await backgrounded;
      };

      leaseGuard.throwIfLost();
      await this.appendEvent(
        runId,
        {
          sequence: sequence.next(),
          type: "status",
          at: this.clock.nowIso(),
          status: "running",
        },
        {
          allowInterruptedResume: resumingInterruptedRun,
          allowFailedCheckpointRetry: retryingFailedRun,
        }
      );

      let runtime: IJSRuntime | undefined;
      try {
        runtime = await this.runtimeFactory.create();
        const setupRuntime = runtime;
        activeRuntime = setupRuntime;
        if (leaseLostError != null) {
          setupRuntime.abort();
        }
        removeAbortListener = abortRuntimeOnSignal(setupRuntime, options?.abortSignal);
        setupRuntime.setLimits({ timeoutMs: WORKFLOW_RUNTIME_TIMEOUT_MS });
        setupRuntime.registerFunction("__workflowArgs", () => Promise.resolve(run.args));
        setupRuntime.registerFunction("__workflowPhase", async (name, details) => {
          assert(typeof name === "string" && name.length > 0, "phase requires a non-empty name");
          leaseGuard.throwIfLost();
          await this.appendEvent(runId, {
            sequence: sequence.next(),
            type: "phase",
            at: this.clock.nowIso(),
            name,
            details,
          });
          return null;
        });
        setupRuntime.registerFunction("__workflowLog", async (message, data) => {
          assert(
            typeof message === "string" && message.length > 0,
            "log requires a non-empty message"
          );
          leaseGuard.throwIfLost();
          await this.appendEvent(runId, {
            sequence: sequence.next(),
            type: "log",
            at: this.clock.nowIso(),
            message,
            data,
          });
          return null;
        });
        setupRuntime.registerFunction("__workflowAgent", async (rawSpec) => {
          try {
            return await this.runAgentStep(runId, sequence, rawSpec, {
              ignoreStartedTaskIds,
              waitOptions: getWorkflowAgentWaitOptions(setupRuntime, options),
              leaseGuard,
            });
          } catch (error) {
            if (isForegroundWaitBackgroundedError(error)) {
              await markBackgrounded();
            }
            throw error;
          }
        });
        setupRuntime.registerFunction("__workflowApplyPatch", async (rawSpec) => {
          try {
            return await this.runApplyPatchStep(runId, sequence, rawSpec, {
              abortSignal: setupRuntime.getAbortSignal(),
              leaseGuard,
            });
          } catch (error) {
            if (isForegroundWaitBackgroundedError(error)) {
              await markBackgrounded();
            }
            throw error;
          }
        });
        setupRuntime.registerFunction("__workflowAction", async (rawName, rawSpec) => {
          try {
            return await this.runActionStep(runId, sequence, rawName, rawSpec, {
              abortSignal: setupRuntime.getAbortSignal(),
              leaseGuard,
            });
          } catch (error) {
            if (isForegroundWaitBackgroundedError(error)) {
              await markBackgrounded();
            }
            throw error;
          }
        });
        setupRuntime.registerFunction("__workflowParallelAgents", async (rawSpecs) => {
          try {
            return await this.runAgentStepsInParallel(runId, sequence, rawSpecs, {
              ignoreStartedTaskIds,
              waitOptions: getWorkflowAgentWaitOptions(setupRuntime, options),
              leaseGuard,
            });
          } catch (error) {
            if (isForegroundWaitBackgroundedError(error)) {
              await markBackgrounded();
            }
            throw error;
          }
        });
      } catch (error) {
        await this.appendFailureStatus(runId, sequence, error, {
          leaseGuard,
          abortSignal: options?.abortSignal,
        });
        throw error;
      }
      if (runtime == null) {
        throw new Error("Workflow runtime setup did not return a runtime");
      }
      using _runtimeResource = runtime;

      let compiledSource: string;
      try {
        compiledSource = compileWorkflowSource(run.definitionSource);
      } catch (error) {
        leaseGuard.throwIfLost();
        await this.appendEvent(runId, {
          sequence: sequence.next(),
          type: "error",
          at: this.clock.nowIso(),
          message: error instanceof Error ? error.message : "Workflow compilation failed",
        });
        await this.appendEvent(runId, {
          sequence: sequence.next(),
          type: "status",
          at: this.clock.nowIso(),
          status: "failed",
        });
        throw error;
      }

      const execution = await runtime.eval(compiledSource);
      if (!execution.success) {
        if (backgrounded != null) {
          throw new WorkflowRunBackgroundedError(runId);
        }
        if (options?.abortSignal?.aborted === true) {
          throw new Error(execution.error ?? "Workflow run aborted");
        }
        await this.throwIfInterrupted(runId);
        leaseGuard.throwIfLost();
        await this.appendEvent(runId, {
          sequence: sequence.next(),
          type: "error",
          at: this.clock.nowIso(),
          message: execution.error ?? "Workflow execution failed",
        });
        await this.appendEvent(runId, {
          sequence: sequence.next(),
          type: "status",
          at: this.clock.nowIso(),
          status: "failed",
        });
        throw new Error(execution.error ?? "Workflow execution failed");
      }

      await this.throwIfInterrupted(runId);
      let result: WorkflowResult;
      try {
        result = normalizeWorkflowResultForEvent(execution.result);
      } catch (error) {
        leaseGuard.throwIfLost();
        await this.appendEvent(runId, {
          sequence: sequence.next(),
          type: "error",
          at: this.clock.nowIso(),
          message: getErrorMessage(error),
        });
        await this.appendEvent(runId, {
          sequence: sequence.next(),
          type: "status",
          at: this.clock.nowIso(),
          status: "failed",
        });
        throw error;
      }
      leaseGuard.throwIfLost();
      await this.appendEvent(runId, {
        sequence: sequence.next(),
        type: "result",
        at: this.clock.nowIso(),
        result,
      });
      await this.throwIfInterrupted(runId);
      leaseGuard.throwIfLost();
      await this.appendEvent(runId, {
        sequence: sequence.next(),
        type: "status",
        at: this.clock.nowIso(),
        status: "completed",
      });
      return result;
    } finally {
      removeAbortListener();
      clearInterval(leaseRenewal);
      await this.runStore.releaseLease(runId, this.runnerId);
    }
  }

  private async appendFailureStatus(
    runId: string,
    sequence: WorkflowEventSequence,
    error: unknown,
    options: { leaseGuard: WorkflowRunnerLeaseGuard; abortSignal?: AbortSignal }
  ): Promise<void> {
    if (options.abortSignal?.aborted === true) {
      return;
    }
    await this.throwIfInterrupted(runId);
    options.leaseGuard.throwIfLost();
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "error",
      at: this.clock.nowIso(),
      message: getErrorMessage(error),
    });
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "status",
      at: this.clock.nowIso(),
      status: "failed",
    });
  }

  private async appendEvent(
    runId: string,
    event: WorkflowRunEvent,
    options: AppendWorkflowRunEventOptions = {}
  ) {
    const { sequence: _storeAssignedSequence, ...eventDraft } = event;
    return await this.runStore.appendNextEvent(runId, eventDraft, {
      ...options,
      expectedLeaseOwnerId: this.runnerId,
    });
  }

  private async recordStepStarted(
    runId: string,
    input: Parameters<WorkflowRunStore["recordStepStarted"]>[1]
  ): Promise<void> {
    await this.runStore.recordStepStarted(runId, input, { expectedLeaseOwnerId: this.runnerId });
  }

  private async recordStepCompleted(
    runId: string,
    input: Parameters<WorkflowRunStore["recordStepCompleted"]>[1]
  ): Promise<void> {
    await this.runStore.recordStepCompleted(runId, input, { expectedLeaseOwnerId: this.runnerId });
  }

  private async recordStepFailed(
    runId: string,
    input: Parameters<WorkflowRunStore["recordStepFailed"]>[1]
  ): Promise<void> {
    await this.runStore.recordStepFailed(runId, input, { expectedLeaseOwnerId: this.runnerId });
  }

  private async throwIfInterrupted(runId: string): Promise<void> {
    const run = await this.runStore.getRun(runId);
    if (run.status === "interrupted") {
      throw new Error(`Workflow run interrupted: ${runId}`);
    }
  }

  private async getDefaultActionCwd(runId: string): Promise<string | undefined> {
    const run = await this.runStore.getRun(runId);
    return run.defaultActionCwd ?? this.defaultActionCwd;
  }

  private async runActionStep(
    runId: string,
    sequence: WorkflowEventSequence,
    rawName: unknown,
    rawSpec: unknown,
    options: {
      abortSignal?: AbortSignal;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<WorkflowActionResult> {
    assert(typeof rawName === "string" && rawName.length > 0, "action requires a name");
    const spec = parseWorkflowActionSpec(rawSpec);
    assertWorkflowStepId(spec.id, "action");
    const registry = this.actionRegistry;
    assert(registry != null, "Workflow actions are not configured for this workflow runner");

    const action = await registry.resolveAction(rawName, {
      projectTrusted: await this.getProjectTrusted(),
      builtInOnly: spec.builtInOnly,
    });
    const cwd = getWorkflowActionCwd(spec, action, await this.getDefaultActionCwd(runId));
    const inputHash = hashWorkflowStepInput(
      spec.id,
      buildWorkflowActionReplayInput(action, spec, cwd)
    );
    options.leaseGuard.throwIfLost();
    const description = await this.actionRunner.describe(action);
    const metadata = validateWorkflowActionMetadata(description.metadata);
    assertWorkflowActionInput(metadata, spec.input, action.name);
    assert(
      spec.cache !== false || metadata.effect === "read",
      "action cache=false is only supported for read actions"
    );

    const unsafeMutatingAttempt = await this.findUnsafePriorActionAttempt(
      runId,
      spec.id,
      inputHash,
      metadata.effect
    );
    if (unsafeMutatingAttempt != null) {
      if (unsafeMutatingAttempt.inputHash !== inputHash) {
        const message = `Workflow action ${action.name} has a prior mutating step with a different replay identity and cannot be replayed automatically`;
        await this.appendWorkflowActionFailure(runId, sequence, spec, action, metadata, message, {
          startedAt: unsafeMutatingAttempt.startedAt,
          inputHash,
        });
        throw new Error(message);
      }
      if (!description.hasReconcile) {
        const message = `Workflow action ${action.name} has an incomplete ${metadata.effect} step and cannot be replayed without reconciliation`;
        await this.appendWorkflowActionFailure(runId, sequence, spec, action, metadata, message, {
          startedAt: unsafeMutatingAttempt.startedAt,
          inputHash,
        });
        throw new Error(message);
      }
      return await this.reconcileActionStep(runId, sequence, {
        spec,
        action,
        metadata,
        inputHash,
        cwd,
        startedAt: unsafeMutatingAttempt.startedAt,
        abortSignal: options.abortSignal,
        leaseGuard: options.leaseGuard,
      });
    }

    const existingStep = await this.runStore.getStep(runId, spec.id, inputHash);
    if (
      spec.cache !== false &&
      existingStep?.status === "completed" &&
      existingStep.result?.structuredOutput != null
    ) {
      const cached = normalizeWorkflowActionResult(existingStep.result.structuredOutput);
      await this.appendEvent(runId, {
        sequence: sequence.next(),
        type: "action",
        at: this.clock.nowIso(),
        stepId: spec.id,
        name: action.name,
        status: "cached",
        effect: await this.getCachedWorkflowActionEffect(runId, spec.id, action),
        sourcePath: action.sourcePath,
        sourceHash: action.sourceHash,
        details: cached,
      });
      return cached;
    }

    return await this.executeActionStep(runId, sequence, {
      spec,
      action,
      metadata,
      inputHash,
      cwd,
      startedAt:
        spec.cache === false
          ? this.clock.nowIso()
          : (existingStep?.startedAt ?? this.clock.nowIso()),
      abortSignal: options.abortSignal,
      leaseGuard: options.leaseGuard,
    });
  }

  private async getCachedWorkflowActionEffect(
    runId: string,
    stepId: string,
    action: ResolvedWorkflowAction
  ): Promise<WorkflowActionEffect> {
    const run = await this.runStore.getRun(runId);
    const event = run.events.findLast(
      (candidate): candidate is Extract<WorkflowRunEvent, { type: "action" }> =>
        candidate.type === "action" &&
        candidate.stepId === stepId &&
        candidate.name === action.name &&
        candidate.sourceHash === action.sourceHash &&
        (candidate.status === "completed" || candidate.status === "reconciled")
    );
    return event?.effect ?? "read";
  }

  private async findUnsafePriorActionAttempt(
    runId: string,
    stepId: string,
    currentInputHash: string,
    currentEffect: WorkflowActionEffect
  ): Promise<WorkflowStepRecord | null> {
    const run = await this.runStore.getRun(runId);
    for (let index = run.steps.length - 1; index >= 0; index -= 1) {
      const step = run.steps[index];
      assert(step != null, "Workflow step index must resolve to a record");
      if (step.stepId !== stepId || !isReplayUnsafeWorkflowActionStepStatus(step.status)) {
        continue;
      }
      // Completed mutating actions have already performed their side effect; do not
      // execute a drifted replay identity under the same durable step id.
      if (step.status === "completed" && step.inputHash === currentInputHash) {
        continue;
      }
      const sameStepActionEvents = run.events.filter(
        (event): event is Extract<WorkflowRunEvent, { type: "action" }> =>
          event.type === "action" && event.stepId === stepId
      );
      const priorEvent = sameStepActionEvents.findLast((event) =>
        isWorkflowActionEventStatusForStep(event.status, step.status)
      );
      const hasAnyMutatingActionEvent = sameStepActionEvents.some((event) =>
        isMutatingWorkflowActionEffect(event.effect)
      );
      // Prior action effect is a side-effect safety boundary. If event/step attribution is
      // ambiguous, prefer blocking over allowing a mutating attempt to be hidden by newer
      // read-only metadata or by a later same-id read action event.
      if (
        isMutatingWorkflowActionEffect(priorEvent?.effect ?? currentEffect) ||
        hasAnyMutatingActionEvent
      ) {
        return step;
      }
    }
    return null;
  }

  private async executeActionStep(
    runId: string,
    sequence: WorkflowEventSequence,
    step: {
      spec: WorkflowActionSpec;
      action: ResolvedWorkflowAction;
      metadata: WorkflowActionMetadata;
      inputHash: string;
      cwd: string;
      startedAt: string;
      abortSignal?: AbortSignal;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<WorkflowActionResult> {
    step.leaseGuard.throwIfLost();
    await this.recordStepStarted(runId, {
      stepId: step.spec.id,
      inputHash: step.inputHash,
      startedAt: step.startedAt,
    });
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "action",
      at: this.clock.nowIso(),
      stepId: step.spec.id,
      name: step.action.name,
      status: "started",
      effect: step.metadata.effect,
      sourcePath: step.action.sourcePath,
      sourceHash: step.action.sourceHash,
      details: workflowActionEventDetails(step.metadata, step.spec, step.cwd),
    });

    try {
      const rawResult = await this.actionRunner.execute(step.action, {
        input: step.spec.input,
        cwd: step.cwd,
        timeoutMs: getWorkflowActionTimeoutMs(step.spec, step.metadata),
        abortSignal: step.abortSignal,
        artifactDir: this.runStore.getStepArtifactsDir(runId, step.spec.id, step.inputHash),
      });
      return await this.recordActionResult(runId, sequence, step, rawResult, "completed");
    } catch (error) {
      await this.recordActionError(runId, sequence, step, error);
      throw error;
    }
  }

  private async reconcileActionStep(
    runId: string,
    sequence: WorkflowEventSequence,
    step: {
      spec: WorkflowActionSpec;
      action: ResolvedWorkflowAction;
      metadata: WorkflowActionMetadata;
      inputHash: string;
      cwd: string;
      startedAt: string;
      abortSignal?: AbortSignal;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<WorkflowActionResult> {
    step.leaseGuard.throwIfLost();
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "action",
      at: this.clock.nowIso(),
      stepId: step.spec.id,
      name: step.action.name,
      status: "started",
      effect: step.metadata.effect,
      sourcePath: step.action.sourcePath,
      sourceHash: step.action.sourceHash,
      details: {
        ...workflowActionEventDetails(step.metadata, step.spec, step.cwd),
        reconciliation: true,
      },
    });

    try {
      const rawResult = await this.actionRunner.reconcile(step.action, {
        input: step.spec.input,
        cwd: step.cwd,
        timeoutMs: getWorkflowActionTimeoutMs(step.spec, step.metadata),
        abortSignal: step.abortSignal,
        artifactDir: this.runStore.getStepArtifactsDir(runId, step.spec.id, step.inputHash),
      });
      const result = await this.recordActionResult(runId, sequence, step, rawResult, "reconciled");
      return { ...result, reconciled: true };
    } catch (error) {
      await this.recordActionError(runId, sequence, step, error);
      throw error;
    }
  }

  private async recordActionResult(
    runId: string,
    sequence: WorkflowEventSequence,
    step: {
      spec: WorkflowActionSpec;
      action: ResolvedWorkflowAction;
      metadata: WorkflowActionMetadata;
      inputHash: string;
      startedAt: string;
      leaseGuard: WorkflowRunnerLeaseGuard;
    },
    rawResult: WorkflowActionExecutionResult,
    status: "completed" | "reconciled"
  ): Promise<WorkflowActionResult> {
    assertWorkflowActionOutput(step.metadata, rawResult.output, step.action.name);
    step.leaseGuard.throwIfLost();
    const result = normalizeWorkflowActionResult({
      output: rawResult.output,
      stdout: rawResult.stdout,
      stderr: rawResult.stderr,
      exitCode: rawResult.exitCode,
      signal: rawResult.signal,
      durationMs: rawResult.durationMs,
      artifacts: rawResult.artifacts,
      ...(status === "reconciled" ? { reconciled: true } : {}),
    });
    await this.recordStepCompleted(runId, {
      stepId: step.spec.id,
      inputHash: step.inputHash,
      result: {
        reportMarkdown: formatWorkflowActionReport(step.action.name, result),
        structuredOutput: result,
      },
      startedAt: step.startedAt,
      completedAt: this.clock.nowIso(),
    });
    step.leaseGuard.throwIfLost();
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "action",
      at: this.clock.nowIso(),
      stepId: step.spec.id,
      name: step.action.name,
      status,
      effect: step.metadata.effect,
      sourcePath: step.action.sourcePath,
      sourceHash: step.action.sourceHash,
      details: result,
    });
    return result;
  }

  private async recordActionError(
    runId: string,
    sequence: WorkflowEventSequence,
    step: {
      spec: WorkflowActionSpec;
      action: ResolvedWorkflowAction;
      metadata: WorkflowActionMetadata;
      inputHash: string;
      startedAt: string;
      leaseGuard: WorkflowRunnerLeaseGuard;
    },
    error: unknown
  ): Promise<void> {
    await this.appendWorkflowActionFailure(
      runId,
      sequence,
      step.spec,
      step.action,
      step.metadata,
      error,
      {
        startedAt: step.startedAt,
        inputHash: step.inputHash,
      }
    );
  }

  private async appendWorkflowActionFailure(
    runId: string,
    sequence: WorkflowEventSequence,
    spec: WorkflowActionSpec,
    action: ResolvedWorkflowAction,
    metadata: WorkflowActionMetadata,
    error: unknown,
    step: { inputHash: string; startedAt: string }
  ): Promise<void> {
    const message = getErrorMessage(error);
    await this.recordStepFailed(runId, {
      stepId: spec.id,
      inputHash: step.inputHash,
      error: message,
      startedAt: step.startedAt,
      completedAt: this.clock.nowIso(),
    });
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "action",
      at: this.clock.nowIso(),
      stepId: spec.id,
      name: action.name,
      status: "failed",
      effect: metadata.effect,
      sourcePath: action.sourcePath,
      sourceHash: action.sourceHash,
      details: workflowActionErrorDetails(error),
    });
  }

  private async runApplyPatchStep(
    runId: string,
    sequence: WorkflowEventSequence,
    rawSpec: unknown,
    options: {
      abortSignal?: AbortSignal;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<WorkflowApplyPatchResult> {
    const spec = parseWorkflowApplyPatchSpec(rawSpec);
    assertWorkflowStepId(spec.id, "applyPatch");
    const inputHash = hashWorkflowStepInput(spec.id, spec);
    options.leaseGuard.throwIfLost();
    const unsafePriorAttempt = await this.findUnsafePriorApplyPatchAttempt(
      runId,
      spec.id,
      inputHash
    );
    if (unsafePriorAttempt != null) {
      const message =
        unsafePriorAttempt.inputHash === inputHash
          ? `Workflow applyPatch step ${spec.id} has an incomplete or failed patch attempt and cannot be replayed automatically`
          : `Workflow applyPatch step ${spec.id} has a prior patch attempt with a different replay identity and cannot be replayed automatically`;
      await this.recordApplyPatchReplayFailure(runId, sequence, spec, inputHash, {
        message,
        startedAt: unsafePriorAttempt.startedAt,
      });
      throw new Error(message);
    }

    const existingStep = await this.runStore.getStep(runId, spec.id, inputHash);
    if (existingStep?.status === "completed" && existingStep.result?.structuredOutput != null) {
      const cached = normalizeWorkflowApplyPatchResult(existingStep.result.structuredOutput);
      await this.recordPatchTerminalEventIfMissing(runId, sequence, {
        stepId: spec.id,
        sourceTaskId: spec.sourceTaskId,
        result: cached,
      });
      return cached;
    }

    options.leaseGuard.throwIfLost();
    await this.assertTaskBelongsToCompletedWorkflowStep(runId, spec.sourceTaskId);
    const startedAt = existingStep?.startedAt ?? this.clock.nowIso();
    await this.recordStepStarted(runId, {
      stepId: spec.id,
      inputHash,
      taskId: spec.sourceTaskId,
      startedAt,
    });
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "patch",
      at: this.clock.nowIso(),
      stepId: spec.id,
      sourceTaskId: spec.sourceTaskId,
      status: "started",
      details:
        spec.projectPath != null
          ? { target: spec.target, projectPath: spec.projectPath }
          : { target: spec.target },
    });

    try {
      if (this.taskAdapter.applyPatch == null) {
        throw new Error("Workflow task adapter does not support applyPatch");
      }
      const rawResult = await this.taskAdapter.applyPatch(spec, {
        abortSignal: options.abortSignal,
      });
      options.leaseGuard.throwIfLost();
      const result = normalizeWorkflowApplyPatchResult(rawResult);
      const reportMarkdown = formatWorkflowApplyPatchReport(result);
      await this.recordStepCompleted(runId, {
        stepId: spec.id,
        inputHash,
        taskId: spec.sourceTaskId,
        result: {
          reportMarkdown,
          structuredOutput: result,
        },
        startedAt,
        completedAt: this.clock.nowIso(),
      });
      await this.appendEvent(runId, {
        sequence: sequence.next(),
        type: "patch",
        at: this.clock.nowIso(),
        stepId: spec.id,
        sourceTaskId: spec.sourceTaskId,
        status: result.status,
        details: result,
      });
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      await this.recordStepFailed(runId, {
        stepId: spec.id,
        inputHash,
        taskId: spec.sourceTaskId,
        error: message,
        startedAt,
        completedAt: this.clock.nowIso(),
      });
      await this.appendEvent(runId, {
        sequence: sequence.next(),
        type: "patch",
        at: this.clock.nowIso(),
        stepId: spec.id,
        sourceTaskId: spec.sourceTaskId,
        status: "failed",
        details: { error: message },
      });
      throw error;
    }
  }

  private async assertTaskBelongsToCompletedWorkflowStep(
    runId: string,
    taskId: string
  ): Promise<void> {
    const run = await this.runStore.getRun(runId);
    const owningStep = run.steps.find(
      (step) =>
        step.status === "completed" && step.taskId === taskId && step.result?.taskId === taskId
    );
    assert(
      owningStep != null,
      `applyPatch source taskId ${taskId} was not produced by a completed workflow agent step`
    );
  }
  private async findUnsafePriorApplyPatchAttempt(
    runId: string,
    stepId: string,
    currentInputHash: string
  ): Promise<WorkflowStepRecord | null> {
    const run = await this.runStore.getRun(runId);
    for (let index = run.steps.length - 1; index >= 0; index -= 1) {
      const step = run.steps[index];
      assert(step != null, "Workflow step index must resolve to a record");
      if (step.stepId !== stepId) {
        continue;
      }
      if (step.status === "completed" && step.inputHash === currentInputHash) {
        continue;
      }
      if (step.status === "started" || step.status === "failed" || step.status === "completed") {
        return step;
      }
    }
    return null;
  }

  private async recordApplyPatchReplayFailure(
    runId: string,
    sequence: WorkflowEventSequence,
    spec: WorkflowApplyPatchSpec,
    inputHash: string,
    failure: { message: string; startedAt: string }
  ): Promise<void> {
    await this.recordStepFailed(runId, {
      stepId: spec.id,
      inputHash,
      taskId: spec.sourceTaskId,
      error: failure.message,
      startedAt: failure.startedAt,
      completedAt: this.clock.nowIso(),
    });
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "patch",
      at: this.clock.nowIso(),
      stepId: spec.id,
      sourceTaskId: spec.sourceTaskId,
      status: "failed",
      details: { error: failure.message, replayBlocked: true },
    });
  }

  private async runAgentStep(
    runId: string,
    sequence: WorkflowEventSequence,
    rawSpec: unknown,
    options: {
      ignoreStartedTaskIds: boolean;
      waitOptions?: WorkflowAgentWaitOptions;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<StructuredTaskOutput> {
    const spec = parseWorkflowAgentSpec(rawSpec);
    assertWorkflowStepId(spec.id, "agent");
    const inputHash = hashWorkflowStepInput(spec.id, spec);
    options.leaseGuard.throwIfLost();
    const existingStep = await this.runStore.getStep(runId, spec.id, inputHash);
    if (existingStep?.status === "completed" && existingStep.result != null) {
      if (existingStep.taskId != null) {
        options.leaseGuard.throwIfLost();
        await this.recordTaskCompletedEventIfMissing(runId, sequence, {
          stepId: spec.id,
          taskId: existingStep.taskId,
        });
      }
      return existingStep.result;
    }

    options.leaseGuard.throwIfLost();
    return await this.runAndRecordAgentStepWithRetries(runId, sequence, {
      spec,
      inputHash,
      startedAt: existingStep?.startedAt ?? this.clock.nowIso(),
      taskId:
        !options.ignoreStartedTaskIds && existingStep?.status === "started"
          ? existingStep.taskId
          : undefined,
      leaseGuard: options.leaseGuard,
      waitOptions: options.waitOptions,
    });
  }

  private async runAgentStepsInParallel(
    runId: string,
    sequence: WorkflowEventSequence,
    rawSpecs: unknown,
    options: {
      ignoreStartedTaskIds: boolean;
      waitOptions?: WorkflowAgentWaitOptions;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<StructuredTaskOutput[]> {
    assert(Array.isArray(rawSpecs), "parallelAgents requires an array of agent specs");
    assert(rawSpecs.length > 0, "parallelAgents requires at least one agent spec");

    const results = new Array<StructuredTaskOutput>(rawSpecs.length);
    const parsedSteps = rawSpecs.map((rawSpec) => {
      const spec = parseWorkflowAgentSpec(rawSpec);
      assertWorkflowStepId(spec.id, "parallelAgents");
      return { spec, inputHash: hashWorkflowStepInput(spec.id, spec) };
    });
    options.leaseGuard.throwIfLost();
    const existingSteps = await this.runStore.getSteps(
      runId,
      parsedSteps.map((step) => ({ stepId: step.spec.id, inputHash: step.inputHash }))
    );
    let pending: Array<{
      index: number;
      spec: WorkflowAgentSpec;
      inputHash: string;
      startedAt: string;
      taskId?: string;
      attempt: number;
      retryMessage?: string;
    }> = [];
    for (const [index, step] of parsedSteps.entries()) {
      const existingStep = existingSteps[index];
      if (existingStep?.status === "completed" && existingStep.result != null) {
        if (existingStep.taskId != null) {
          options.leaseGuard.throwIfLost();
          await this.recordTaskCompletedEventIfMissing(runId, sequence, {
            stepId: step.spec.id,
            taskId: existingStep.taskId,
          });
        }
        results[index] = existingStep.result;
        continue;
      }
      pending.push({
        index,
        spec: step.spec,
        inputHash: step.inputHash,
        startedAt: existingStep?.startedAt ?? this.clock.nowIso(),
        taskId:
          !options.ignoreStartedTaskIds && existingStep?.status === "started"
            ? existingStep.taskId
            : undefined,
        attempt: 1,
      });
    }

    while (pending.length > 0) {
      const currentPending = pending;
      pending = [];
      const batchAbortController = new AbortController();
      const upstreamAbortSignal = options.waitOptions?.abortSignal;
      const abortBatch = () => batchAbortController.abort();
      if (upstreamAbortSignal?.aborted) {
        abortBatch();
      } else {
        upstreamAbortSignal?.addEventListener("abort", abortBatch, { once: true });
      }
      let foregroundBackgrounded = false;
      let interruptPromise: Promise<void> | undefined;
      const interruptRemainingTasks = async (): Promise<void> => {
        interruptPromise ??= this.taskAdapter.interruptRun?.() ?? Promise.resolve();
        try {
          await interruptPromise;
        } catch {
          // Preserve the original child failure; workflow failure handling will surface that cause.
        }
      };
      const batchWaitOptions: WorkflowAgentWaitOptions = {
        ...options.waitOptions,
        abortSignal: batchAbortController.signal,
      };
      const effectivePending = currentPending.map((step) => ({
        ...step,
        runSpec:
          step.attempt === 1
            ? step.spec
            : buildRetryAgentSpec(
                step.spec,
                step.attempt - 1,
                step.retryMessage ?? "previous attempt failed"
              ),
      }));
      const bulkCreatableSteps = effectivePending.filter((step) => step.taskId == null);
      if (
        bulkCreatableSteps.length > 0 &&
        this.taskAdapter.createAgentTasks != null &&
        this.taskAdapter.waitForAgentTask != null
      ) {
        try {
          const createdTasks = await this.taskAdapter.createAgentTasks(
            bulkCreatableSteps.map((step) => step.runSpec),
            {
              onTaskCreated: async (index, taskId) => {
                const step = bulkCreatableSteps[index];
                assert(step != null, "WorkflowRunner.parallelAgents bulk lifecycle index mismatch");
                assert(taskId.length > 0, "WorkflowRunner.parallelAgents bulk taskId is required");
                options.leaseGuard.throwIfLost();
                await this.recordStepStarted(runId, {
                  stepId: step.spec.id,
                  inputHash: step.inputHash,
                  taskId,
                  startedAt: step.startedAt,
                });
                await this.recordTaskStartedEventIfMissing(runId, sequence, {
                  stepId: step.spec.id,
                  taskId,
                });
              },
            }
          );
          if (createdTasks.length !== bulkCreatableSteps.length) {
            throw new Error("parallelAgents bulk task creation returned the wrong number of tasks");
          }
          for (const [index, createdTask] of createdTasks.entries()) {
            assert(
              createdTask.taskId.length > 0,
              "WorkflowRunner.parallelAgents created taskId is required"
            );
            bulkCreatableSteps[index].taskId = createdTask.taskId;
          }
        } catch (error) {
          if (isForegroundWaitBackgroundedError(error)) {
            foregroundBackgrounded = true;
            abortBatch();
          } else if (!foregroundBackgrounded) {
            await interruptRemainingTasks();
          }
          throw error;
        }
      }
      const guardedRuns = effectivePending.map(async (step, pendingIndex) => {
        try {
          const rawResult = await this.runOrResumeAgentStep(runId, sequence, {
            spec: step.runSpec,
            inputHash: step.inputHash,
            startedAt: step.startedAt,
            taskId: step.taskId,
            leaseGuard: options.leaseGuard,
            waitOptions: batchWaitOptions,
          });
          return { pendingIndex, step, rawResult };
        } catch (error) {
          if (isForegroundWaitBackgroundedError(error)) {
            foregroundBackgrounded = true;
            abortBatch();
          } else if (!foregroundBackgrounded) {
            await interruptRemainingTasks();
          }
          return { pendingIndex, step, error };
        }
      });
      const unsettledRuns = new Map(guardedRuns.map((run, index) => [index, run]));
      try {
        while (unsettledRuns.size > 0) {
          const settled = await Promise.race(unsettledRuns.values());
          unsettledRuns.delete(settled.pendingIndex);
          if ("error" in settled) {
            await Promise.allSettled(unsettledRuns.values());
            if (foregroundBackgrounded) {
              throw createForegroundWaitBackgroundedError();
            }
            throw settled.error;
          }
          try {
            results[settled.step.index] = await this.recordAgentResult(runId, sequence, {
              ...settled.step,
              leaseGuard: options.leaseGuard,
              rawResult: settled.rawResult,
            });
          } catch (error) {
            if (
              !isRetryableAgentOutputError(error) ||
              settled.step.attempt >= WORKFLOW_AGENT_MAX_ATTEMPTS
            ) {
              await interruptRemainingTasks();
              await Promise.allSettled(unsettledRuns.values());
              throw error;
            }
            options.leaseGuard.throwIfLost();
            await this.recordAgentRetry(
              runId,
              sequence,
              settled.step.spec.id,
              settled.step.attempt,
              error
            );
            pending.push({
              ...settled.step,
              startedAt: this.clock.nowIso(),
              taskId: undefined,
              attempt: settled.step.attempt + 1,
              retryMessage: getErrorMessage(error),
            });
          }
        }
      } finally {
        upstreamAbortSignal?.removeEventListener("abort", abortBatch);
      }
    }
    return results;
  }

  private async runAndRecordAgentStepWithRetries(
    runId: string,
    sequence: WorkflowEventSequence,
    step: {
      spec: WorkflowAgentSpec;
      inputHash: string;
      startedAt: string;
      taskId?: string;
      waitOptions?: WorkflowAgentWaitOptions;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<StructuredTaskOutput> {
    let attempt = 1;
    let startedAt = step.startedAt;
    let taskId = step.taskId;
    let spec = step.spec;
    while (attempt <= WORKFLOW_AGENT_MAX_ATTEMPTS) {
      const rawResult = await this.runOrResumeAgentStep(runId, sequence, {
        spec,
        inputHash: step.inputHash,
        startedAt,
        taskId,
        leaseGuard: step.leaseGuard,
        waitOptions: step.waitOptions,
      });
      try {
        return await this.recordAgentResult(runId, sequence, {
          spec: step.spec,
          inputHash: step.inputHash,
          startedAt,
          leaseGuard: step.leaseGuard,
          rawResult,
        });
      } catch (error) {
        if (!isRetryableAgentOutputError(error) || attempt >= WORKFLOW_AGENT_MAX_ATTEMPTS) {
          throw error;
        }
        step.leaseGuard.throwIfLost();
        await this.recordAgentRetry(runId, sequence, step.spec.id, attempt, error);
        spec = buildRetryAgentSpec(step.spec, attempt, getErrorMessage(error));
        startedAt = this.clock.nowIso();
        taskId = undefined;
        attempt += 1;
      }
    }
    throw new Error(`agent ${step.spec.id} exhausted validation retries`);
  }

  private async recordAgentRetry(
    runId: string,
    sequence: WorkflowEventSequence,
    stepId: string,
    attempt: number,
    error: unknown
  ): Promise<void> {
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "log",
      at: this.clock.nowIso(),
      message: `Retrying ${stepId} after validation failure`,
      data: {
        attempt,
        maxAttempts: WORKFLOW_AGENT_MAX_ATTEMPTS,
        error: getErrorMessage(error),
      },
    });
  }

  private async runOrResumeAgentStep(
    runId: string,
    sequence: WorkflowEventSequence,
    step: {
      spec: WorkflowAgentSpec;
      inputHash: string;
      startedAt: string;
      taskId?: string;
      waitOptions?: WorkflowAgentWaitOptions;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<WorkflowAgentResult> {
    step.leaseGuard.throwIfLost();
    if (step.taskId != null && this.taskAdapter.waitForAgentTask != null) {
      await this.recordTaskStartedEventIfMissing(runId, sequence, {
        stepId: step.spec.id,
        taskId: step.taskId,
      });
      try {
        return await this.taskAdapter.waitForAgentTask(step.taskId, step.spec, step.waitOptions);
      } catch (error) {
        if (!isForegroundWaitBackgroundedError(error)) {
          step.leaseGuard.throwIfLost();
          await this.recordTaskTerminalEventIfMissing(runId, sequence, {
            stepId: step.spec.id,
            taskId: step.taskId,
            status: getTaskTerminalStatusForError(error, step.waitOptions?.abortSignal),
          });
        }
        if (!shouldRestartUnrecoverableStartedTask(error)) {
          throw error;
        }
      }
    }

    step.leaseGuard.throwIfLost();
    let recordedTaskId: string | undefined;
    let rawResult: WorkflowAgentResult;
    try {
      rawResult = await this.taskAdapter.runAgent(
        step.spec,
        {
          onTaskCreated: async (taskId) => {
            step.leaseGuard.throwIfLost();
            recordedTaskId = taskId;
            await this.recordStepStarted(runId, {
              stepId: step.spec.id,
              inputHash: step.inputHash,
              taskId,
              startedAt: step.startedAt,
            });
            await this.recordTaskStartedEventIfMissing(runId, sequence, {
              stepId: step.spec.id,
              taskId,
            });
          },
        },
        step.waitOptions
      );
    } catch (error) {
      if (recordedTaskId != null && !isForegroundWaitBackgroundedError(error)) {
        step.leaseGuard.throwIfLost();
        await this.recordTaskTerminalEventIfMissing(runId, sequence, {
          stepId: step.spec.id,
          taskId: recordedTaskId,
          status: getTaskTerminalStatusForError(error, step.waitOptions?.abortSignal),
        });
      }
      throw error;
    }
    step.leaseGuard.throwIfLost();
    if (recordedTaskId == null) {
      await this.recordStepStarted(runId, {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId: rawResult.taskId,
        startedAt: step.startedAt,
      });
      await this.recordTaskStartedEventIfMissing(runId, sequence, {
        stepId: step.spec.id,
        taskId: rawResult.taskId,
      });
    }
    return rawResult;
  }

  private async recordTaskStartedEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    task: { stepId: string; taskId: string }
  ): Promise<void> {
    await this.recordTaskEventIfMissing(runId, sequence, { ...task, status: "started" });
  }

  private async recordTaskCompletedEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    task: { stepId: string; taskId: string }
  ): Promise<void> {
    await this.recordTaskEventIfMissing(runId, sequence, { ...task, status: "completed" });
  }

  private async recordTaskTerminalEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    task: { stepId: string; taskId: string; status: "failed" | "interrupted" }
  ): Promise<void> {
    await this.recordTaskEventIfMissing(runId, sequence, task);
  }

  private async recordTaskEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    task: { stepId: string; taskId: string; status: string }
  ): Promise<void> {
    assert(runId.length > 0, "WorkflowRunner.recordTaskEventIfMissing: runId is required");
    assert(task.stepId.length > 0, "WorkflowRunner: task event stepId is required");
    assert(task.taskId.length > 0, "WorkflowRunner: task event taskId is required");
    assert(task.status.length > 0, "WorkflowRunner: task event status is required");

    await using _lock = await this.taskEventMutex.acquire();
    sequence.next();
    await this.runStore.appendTaskEventIfMissing(
      runId,
      {
        stepId: task.stepId,
        taskId: task.taskId,
        status: task.status,
        at: this.clock.nowIso(),
      },
      { expectedLeaseOwnerId: this.runnerId }
    );
  }

  private async recordPatchTerminalEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    patch: { stepId: string; sourceTaskId: string; result: WorkflowApplyPatchResult }
  ): Promise<void> {
    assert(runId.length > 0, "WorkflowRunner.recordPatchTerminalEventIfMissing: runId is required");
    assert(patch.stepId.length > 0, "WorkflowRunner: patch event stepId is required");
    assert(patch.sourceTaskId.length > 0, "WorkflowRunner: patch event sourceTaskId is required");

    await using _lock = await this.taskEventMutex.acquire();
    const run = await this.runStore.getRun(runId);
    const alreadyRecorded = run.events.some(
      (event) =>
        event.type === "patch" &&
        event.status === patch.result.status &&
        event.stepId === patch.stepId &&
        event.sourceTaskId === patch.sourceTaskId
    );
    if (alreadyRecorded) {
      return;
    }
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "patch",
      at: this.clock.nowIso(),
      stepId: patch.stepId,
      sourceTaskId: patch.sourceTaskId,
      status: patch.result.status,
      details: patch.result,
    });
  }

  private async recordAgentResult(
    runId: string,
    sequence: WorkflowEventSequence,
    step: {
      spec: WorkflowAgentSpec;
      inputHash: string;
      startedAt: string;
      leaseGuard: WorkflowRunnerLeaseGuard;
      rawResult: WorkflowAgentResult;
    }
  ): Promise<StructuredTaskOutput> {
    let result: StructuredTaskOutput;
    try {
      result = StructuredTaskOutputSchema.parse(step.rawResult);
    } catch (error) {
      const message = `agent ${step.spec.id} returned invalid task output: ${getErrorMessage(error)}`;
      await this.recordFailedAgentAttempt(runId, sequence, step, message);
      throw new WorkflowAgentOutputValidationError(message);
    }

    if (step.spec.outputSchema !== undefined) {
      const validation = validateJsonSchemaSubset(step.spec.outputSchema, result.structuredOutput);
      if (!validation.success) {
        const message = `agent ${step.spec.id} structured output failed schema validation: ${validation.errors
          .map((error) => `${error.path}: ${error.message}`)
          .join("; ")}`;
        await this.recordFailedAgentAttempt(runId, sequence, step, message);
        throw new WorkflowAgentOutputValidationError(message);
      }
    }
    step.leaseGuard.throwIfLost();
    const taskId = this.getTaskIdFromAgentResult(step.rawResult, step.spec.id);
    const completedAt = this.clock.nowIso();
    sequence.next();
    await this.runStore.recordStepCompletedAndAppendTaskEvent(
      runId,
      {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId,
        result,
        startedAt: step.startedAt,
        completedAt,
      },
      { expectedLeaseOwnerId: this.runnerId }
    );
    return result;
  }

  private async recordFailedAgentAttempt(
    runId: string,
    sequence: WorkflowEventSequence,
    step: {
      spec: WorkflowAgentSpec;
      inputHash: string;
      startedAt: string;
      leaseGuard: WorkflowRunnerLeaseGuard;
      rawResult: WorkflowAgentResult;
    },
    message: string
  ): Promise<void> {
    step.leaseGuard.throwIfLost();
    const taskId = getTaskIdFromUnknownAgentResult(step.rawResult);
    const failedAt = this.clock.nowIso();
    sequence.next();
    if (taskId != null) {
      sequence.next();
    }
    await this.runStore.recordStepFailedAndAppendTaskEvent(
      runId,
      {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId,
        error: message,
        startedAt: step.startedAt,
        completedAt: failedAt,
        validationAt: failedAt,
        taskFailedAt: failedAt,
      },
      { expectedLeaseOwnerId: this.runnerId }
    );
  }

  private getTaskIdFromAgentResult(result: WorkflowAgentResult, stepId: string): string {
    const maybeTaskId = result.taskId;
    assert(
      typeof maybeTaskId === "string" && maybeTaskId.length > 0,
      `agent ${stepId} returned no taskId`
    );
    return maybeTaskId;
  }
}

class WorkflowEventSequence {
  constructor(private current: number) {}

  next(): number {
    this.current += 1;
    return this.current;
  }
}

function parseWorkflowActionSpec(rawSpec: unknown): WorkflowActionSpec {
  assert(rawSpec != null && typeof rawSpec === "object", "action requires a spec object");
  const spec = rawSpec as Record<string, unknown>;
  assert(typeof spec.id === "string", "action replay boundary requires a stable id");
  const parsed: WorkflowActionSpec = {
    id: spec.id,
    input: spec.input ?? null,
  };
  const timeoutMs = spec.timeoutMs ?? spec.timeout_ms;
  if (timeoutMs !== undefined) {
    assert(
      typeof timeoutMs === "number" && Number.isInteger(timeoutMs) && timeoutMs > 0,
      "action timeoutMs must be a positive integer"
    );
    parsed.timeoutMs = timeoutMs;
  }
  const cwd = spec.cwd ?? spec.worktreePath ?? spec.worktree_path;
  if (cwd !== undefined) {
    assert(typeof cwd === "string" && cwd.length > 0, "action cwd must be a non-empty string");
    parsed.cwd = cwd;
  }
  const builtInOnly = spec.builtInOnly ?? spec.builtinOnly ?? spec.builtin_only;
  if (builtInOnly !== undefined) {
    assert(typeof builtInOnly === "boolean", "action builtInOnly must be a boolean");
    parsed.builtInOnly = builtInOnly;
  }
  const cache = spec.cache;
  if (cache !== undefined) {
    assert(typeof cache === "boolean", "action cache must be a boolean");
    parsed.cache = cache;
  }
  return parsed;
}

function buildWorkflowActionReplayInput(
  action: ResolvedWorkflowAction,
  spec: WorkflowActionSpec,
  cwd: string
): unknown {
  return {
    primitive: "action",
    actionName: action.name,
    scope: action.scope,
    sourcePath: action.sourcePath,
    sourceHash: action.sourceHash,
    input: spec.input,
    cwd,
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.builtInOnly === true ? { builtInOnly: true } : {}),
    ...(spec.cache === false ? { cache: false } : {}),
  };
}

function assertWorkflowActionInput(
  metadata: WorkflowActionMetadata,
  input: unknown,
  actionName: string
): void {
  if (metadata.inputSchema === undefined) {
    return;
  }
  const validation = validateJsonSchemaSubset(metadata.inputSchema, input);
  if (!validation.success) {
    throw new Error(
      `action ${actionName} input failed schema validation: ${validation.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join("; ")}`
    );
  }
}

function assertWorkflowActionOutput(
  metadata: WorkflowActionMetadata,
  output: unknown,
  actionName: string
): void {
  if (metadata.outputSchema === undefined) {
    return;
  }
  const validation = validateJsonSchemaSubset(metadata.outputSchema, output);
  if (!validation.success) {
    throw new Error(
      `action ${actionName} output failed schema validation: ${validation.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join("; ")}`
    );
  }
}

function isMutatingWorkflowActionEffect(effect: WorkflowActionEffect): boolean {
  return effect === "workspace" || effect === "external";
}

function isReplayUnsafeWorkflowActionStepStatus(status: WorkflowStepRecord["status"]): boolean {
  return status === "started" || status === "failed" || status === "completed";
}

function isWorkflowActionEventStatusForStep(
  eventStatus: Extract<WorkflowRunEvent, { type: "action" }>["status"],
  stepStatus: WorkflowStepRecord["status"]
): boolean {
  if (stepStatus === "completed") {
    return eventStatus === "completed" || eventStatus === "reconciled";
  }
  return eventStatus === stepStatus;
}

function getWorkflowActionTimeoutMs(
  spec: WorkflowActionSpec,
  metadata: WorkflowActionMetadata
): number {
  return spec.timeoutMs ?? metadata.timeoutMs ?? 60_000;
}

function getWorkflowActionCwd(
  spec: WorkflowActionSpec,
  action: ResolvedWorkflowAction,
  defaultCwd?: string
): string {
  const fallbackCwd = defaultCwd ?? action.sourcePath.split(/[\\/][^\\/]*$/u)[0] ?? ".";
  if (spec.cwd == null) {
    return fallbackCwd;
  }
  return path.isAbsolute(spec.cwd) ? spec.cwd : path.resolve(fallbackCwd, spec.cwd);
}

function workflowActionEventDetails(
  metadata: WorkflowActionMetadata,
  spec: WorkflowActionSpec,
  cwd: string
): Record<string, unknown> {
  return {
    description: metadata.description,
    effect: metadata.effect,
    advisoryPermissions: metadata.permissions ?? [],
    timeoutMs: getWorkflowActionTimeoutMs(spec, metadata),
    cwd,
  };
}

function workflowActionErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof WorkflowActionExecutionError) {
    return {
      error: error.message,
      stdout: error.stdout,
      stderr: error.stderr,
      exitCode: error.exitCode,
      signal: error.signal,
      durationMs: error.durationMs,
      artifacts: error.artifacts,
    };
  }
  return { error: getErrorMessage(error) };
}

function normalizeWorkflowActionResult(rawResult: unknown): WorkflowActionResult {
  assert(rawResult != null && typeof rawResult === "object", "action result must be an object");
  const record = rawResult as Record<string, unknown>;
  assert(typeof record.durationMs === "number", "action result requires durationMs");
  assert(Array.isArray(record.artifacts), "action result requires artifacts");
  return {
    output: record.output ?? null,
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
    signal: typeof record.signal === "string" ? record.signal : null,
    durationMs: record.durationMs,
    artifacts: record.artifacts.map((artifact) => normalizeWorkflowActionArtifact(artifact)),
    ...(record.reconciled === true ? { reconciled: true } : {}),
  };
}

function normalizeWorkflowActionArtifact(artifact: unknown): {
  name: string;
  path: string;
  sizeBytes: number;
} {
  assert(artifact != null && typeof artifact === "object", "action artifact must be an object");
  const record = artifact as Record<string, unknown>;
  assert(
    typeof record.name === "string" && record.name.length > 0,
    "action artifact requires name"
  );
  assert(
    typeof record.path === "string" && record.path.length > 0,
    "action artifact requires path"
  );
  assert(typeof record.sizeBytes === "number", "action artifact requires sizeBytes");
  return { name: record.name, path: record.path, sizeBytes: record.sizeBytes };
}

function formatWorkflowActionReport(actionName: string, result: WorkflowActionResult): string {
  return `Action ${actionName} completed in ${result.durationMs}ms.`;
}

function parseWorkflowApplyPatchSpec(rawSpec: unknown): WorkflowApplyPatchSpec {
  assert(rawSpec != null && typeof rawSpec === "object", "applyPatch requires a spec object");
  const spec = rawSpec as Record<string, unknown>;
  assert(typeof spec.id === "string", "applyPatch replay boundary requires a stable id");

  const sourceTaskId = getApplyPatchSourceTaskId(
    spec.source ?? spec.from ?? spec.task ?? spec.taskId
  );
  assert(
    typeof sourceTaskId === "string" && sourceTaskId.length > 0,
    "applyPatch requires a source taskId or an agent result with taskId"
  );

  const target = spec.target ?? "parent";
  assert(target === "parent", "applyPatch target currently supports only 'parent'");
  if (spec.onConflict !== undefined) {
    assert(spec.onConflict === "return", "applyPatch onConflict currently supports only 'return'");
  }
  if (spec.strategy !== undefined) {
    assert(
      spec.strategy === "three-way" || spec.strategy === "dry-run-then-apply",
      "applyPatch strategy currently supports 'three-way' or 'dry-run-then-apply'"
    );
  }

  const parsed: WorkflowApplyPatchSpec = {
    id: spec.id,
    sourceTaskId,
    target,
    threeWay: spec.threeWay !== false && spec.three_way !== false,
    force: spec.force === true,
  };
  const expectedHeadSha = spec.expectedHeadSha ?? spec.expected_head_sha;
  if (expectedHeadSha !== undefined) {
    assert(
      typeof expectedHeadSha === "string" && expectedHeadSha.length > 0,
      "applyPatch expectedHeadSha must be a non-empty string"
    );
    parsed.expectedHeadSha = expectedHeadSha;
  }
  if (typeof spec.projectPath === "string" && spec.projectPath.length > 0) {
    parsed.projectPath = spec.projectPath;
  } else if (typeof spec.project_path === "string" && spec.project_path.length > 0) {
    parsed.projectPath = spec.project_path;
  }
  return parsed;
}

function getApplyPatchSourceTaskId(source: unknown): string | undefined {
  if (typeof source === "string" && source.length > 0) {
    return source;
  }
  if (source != null && typeof source === "object") {
    const taskId = (source as Record<string, unknown>).taskId;
    if (typeof taskId === "string" && taskId.length > 0) {
      return taskId;
    }
  }
  return undefined;
}

function isWorkflowApplyPatchResult(value: unknown): value is WorkflowApplyPatchResult {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.success === "boolean" &&
    typeof record.taskId === "string" &&
    (record.status === "applied" || record.status === "conflict" || record.status === "failed")
  );
}

function normalizeWorkflowApplyPatchResult(rawResult: unknown): WorkflowApplyPatchResult {
  if (isWorkflowApplyPatchResult(rawResult)) {
    return rawResult;
  }
  const parsed = TaskApplyGitPatchToolResultSchema.parse(rawResult);
  const conflictPaths = getConflictPathsFromPatchResult(parsed);
  const failedPatchSubject = getFailedPatchSubjectFromPatchResult(parsed);
  const status: WorkflowApplyPatchStatus = parsed.success
    ? "applied"
    : conflictPaths.length > 0 || failedPatchSubject != null
      ? "conflict"
      : "failed";

  return stripUndefinedDeep({
    success: parsed.success,
    status,
    taskId: parsed.taskId,
    ...(parsed.dryRun !== undefined ? { dryRun: parsed.dryRun } : {}),
    ...(parsed.projectResults !== undefined ? { projectResults: parsed.projectResults } : {}),
    ...(parsed.appliedCommits !== undefined ? { appliedCommits: parsed.appliedCommits } : {}),
    ...(parsed.headCommitSha !== undefined ? { headCommitSha: parsed.headCommitSha } : {}),
    ...(conflictPaths.length > 0 ? { conflictPaths } : {}),
    ...(failedPatchSubject !== undefined ? { failedPatchSubject } : {}),
    ...(parsed.success ? {} : { error: parsed.error }),
    ...(parsed.note !== undefined ? { note: parsed.note } : {}),
  }) as WorkflowApplyPatchResult;
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefinedDeep);
  }
  if (value == null || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (nestedValue !== undefined) {
      output[key] = stripUndefinedDeep(nestedValue);
    }
  }
  return output;
}

function getFailedPatchSubjectFromPatchResult(
  result: ReturnType<typeof TaskApplyGitPatchToolResultSchema.parse>
): string | undefined {
  if (result.success) {
    return undefined;
  }
  if (result.failedPatchSubject != null) {
    return result.failedPatchSubject;
  }
  return result.projectResults
    ?.map((projectResult) => projectResult.failedPatchSubject)
    .find((subject) => subject != null);
}

function getConflictPathsFromPatchResult(
  result: ReturnType<typeof TaskApplyGitPatchToolResultSchema.parse>
): string[] {
  const paths = new Set<string>();
  const topLevelConflictPaths = result.success ? [] : (result.conflictPaths ?? []);
  for (const path of topLevelConflictPaths) {
    paths.add(path);
  }
  for (const projectResult of result.projectResults ?? []) {
    for (const path of projectResult.conflictPaths ?? []) {
      paths.add(path);
    }
  }
  return Array.from(paths);
}

function formatWorkflowApplyPatchReport(result: WorkflowApplyPatchResult): string {
  if (result.status === "applied") {
    return `Patch applied from task ${result.taskId}.`;
  }
  if (result.status === "conflict") {
    const paths = result.conflictPaths?.length
      ? ` Conflicts: ${result.conflictPaths.join(", ")}.`
      : "";
    return `Patch from task ${result.taskId} did not apply cleanly.${paths}`;
  }
  return `Patch from task ${result.taskId} failed: ${result.error ?? "unknown error"}`;
}

function parseWorkflowAgentSpec(rawSpec: unknown): WorkflowAgentSpec {
  assert(rawSpec != null && typeof rawSpec === "object", "agent requires a spec object");
  const spec = rawSpec as Record<string, unknown>;
  assert(typeof spec.id === "string", "agent replay boundary requires a stable id");
  assert(
    typeof spec.prompt === "string" && spec.prompt.length > 0,
    "agent requires a non-empty prompt"
  );
  const parsed: WorkflowAgentSpec = {
    id: spec.id,
    prompt: spec.prompt,
  };
  if (typeof spec.title === "string" && spec.title.length > 0) {
    parsed.title = spec.title;
  }
  if (typeof spec.agentId === "string" && spec.agentId.length > 0) {
    parsed.agentId = spec.agentId;
  }
  if (spec.outputSchema !== undefined) {
    parsed.outputSchema = spec.outputSchema;
  }
  return parsed;
}

function normalizeWorkflowResultForEvent(result: unknown): WorkflowResult {
  if (result != null && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record.reportMarkdown === "string") {
      return WorkflowResultSchema.parse({
        reportMarkdown: record.reportMarkdown,
        structuredOutput: record.structuredOutput,
      });
    }
  }

  let reportMarkdown: string | undefined;
  try {
    reportMarkdown = JSON.stringify(result);
  } catch (error) {
    throw new Error(`Workflow result must be JSON-serializable: ${getErrorMessage(error)}`);
  }
  assert(
    typeof reportMarkdown === "string",
    "Workflow must return a reportMarkdown result or another JSON-serializable value"
  );
  return WorkflowResultSchema.parse({ reportMarkdown });
}

function compileWorkflowSource(source: string): string {
  // Workflow definitions are evaluated as a script (not a module), so export
  // syntax must be rewritten away. Top-level named export declarations are
  // allowed so built-in workflows can expose pure helpers for direct unit
  // tests; only the declaration forms below are supported (no `export {...}`
  // lists). Like the default-export rewrite, this is a lexical transform: a
  // template-literal line inside the workflow that starts with `export ` would
  // also be rewritten. scripts/gen_builtin_workflows.ts guards built-in
  // sources against that corruption at generation time; scratch/project
  // authors must keep flush-left `export ` lines out of template literals.
  const withoutNamedExports = source.replace(
    /^export\s+(?=(?:async\s+)?function\s|class\s|const\s|let\s|var\s)/gmu,
    ""
  );
  const compiled = withoutNamedExports.replace(
    /export\s+default\s+(async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/u,
    (_match, asyncKeyword: string | undefined) => `${asyncKeyword ?? ""}function __muxWorkflow(`
  );
  assert(compiled !== withoutNamedExports, "Workflow definition must export a default function");

  return `
Date = undefined;
Math.random = undefined;
function __muxCreateWorkflowActionProxy(path) {
  return new Proxy(function () {}, {
    get: function (_target, prop) {
      if (prop === "then") return undefined;
      if (prop === "invoke") {
        return function (name, spec) { return __workflowAction(name, spec); };
      }
      if (typeof prop !== "string") return undefined;
      return __muxCreateWorkflowActionProxy(path.concat([prop]));
    },
    apply: function (_target, _thisArg, args) {
      if (path.length === 0) {
        return __workflowAction(args[0], args.length > 1 ? args[1] : {});
      }
      if (args.length === 2 && typeof args[0] === "string") {
        return __workflowAction(path.join("."), { id: args[0], input: args[1] });
      }
      return __workflowAction(path.join("."), args[0]);
    },
  });
}
${compiled}
return (async () => await __muxWorkflow({
  args: __workflowArgs(),
  phase: __workflowPhase,
  log: __workflowLog,
  agent: __workflowAgent,
  action: __muxCreateWorkflowActionProxy([]),
  applyPatch: __workflowApplyPatch,
  parallelAgents: __workflowParallelAgents,
}))();
`;
}
