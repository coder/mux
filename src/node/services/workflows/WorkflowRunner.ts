import { StructuredTaskOutputSchema, WorkflowResultSchema } from "@/common/orpc/schemas";
import { TaskApplyGitPatchToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import type {
  StructuredTaskOutput,
  WorkflowResult,
  WorkflowRunEvent,
  WorkflowStepRecord,
} from "@/common/types/workflow";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import {
  formatJsonSchemaValidationErrors,
  validateJsonSchemaSubset,
  validateJsonSchemaSubsetSchema,
} from "@/common/utils/jsonSchemaSubset";
import { removeCommonJsWorkflowMetadataDeclaration } from "./staticWorkflowMetadata";
import { WORKFLOW_RUNTIME_STDLIB_SOURCE } from "./workflowRuntimeSources.generated";
import type { IJSRuntime, IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
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
  isolation?: "fork" | "none";
  outputSchema?: unknown;
  /**
   * Model-refusal policy for this step's child task. "fail" opts out of
   * configured model-fallback chains so a refusal fails the step terminally
   * (verifier steps demand honest failure, not a silent model swap).
   * Defaults to "fallback" (chains apply when configured).
   */
  onRefusal?: "fail" | "fallback";
}

export interface WorkflowAgentWaitOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  backgroundOnMessageQueued?: boolean;
}

export type WorkflowAgentResult = StructuredTaskOutput & { taskId: string };

interface WorkflowAgentRunResult {
  rawResult: WorkflowAgentResult;
  resultSpec: WorkflowAgentSpec;
}

export type WorkflowApplyPatchStatus = "applied" | "conflict" | "failed";

export interface WorkflowApplyPatchSpec {
  id: string;
  sourceTaskId: string;
  target: "parent";
  projectPath?: string;
  threeWay: boolean;
  expectedHeadSha?: string;
  force: boolean;
  allowedPathPrefixes?: string[];
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
  /**
   * Called when the run reaches a terminal state. Not called when the run is
   * backgrounded (the background continuation re-enters run()) or when the
   * lease was held by another runner.
   */
  onRunEnded?(): Promise<void> | void;
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

// Parallel fan-out primitives accept an optional second argument: { maxParallel?: number }.
// maxParallel caps how many steps run at once; remaining specs start as running
// ones finish (sliding window) instead of all launching up front.
function parseWorkflowParallelOptions(
  raw: unknown,
  primitiveName: "parallelAgents"
): { maxParallel?: number } {
  if (raw == null) {
    return {};
  }
  assert(
    typeof raw === "object" && !Array.isArray(raw),
    `${primitiveName} options must be an object`
  );
  const { maxParallel } = raw as { maxParallel?: unknown };
  if (maxParallel == null) {
    return {};
  }
  assert(
    typeof maxParallel === "number" && Number.isInteger(maxParallel) && maxParallel > 0,
    `${primitiveName} options.maxParallel must be a positive integer`
  );
  return { maxParallel };
}

function parseParallelAgentsOptions(raw: unknown): { maxParallel?: number } {
  return parseWorkflowParallelOptions(raw, "parallelAgents");
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
  private readonly runnerId: string;
  private readonly clock: WorkflowRunnerClock;
  private readonly taskEventMutex = new AsyncMutex();

  constructor(options: WorkflowRunnerOptions) {
    assert(options.runnerId.length > 0, "WorkflowRunner: runnerId is required");
    this.runStore = options.runStore;
    this.runtimeFactory = options.runtimeFactory;
    this.taskAdapter = options.taskAdapter;
    this.runnerId = options.runnerId;
    this.clock = options.clock ?? DEFAULT_CLOCK;
  }

  async run(runId: string, options?: WorkflowRunnerRunOptions): Promise<WorkflowResult> {
    assert(runId.length > 0, "WorkflowRunner.run: runId is required");
    try {
      const result = await this.runWithLease(runId, options);
      await this.taskAdapter.onRunEnded?.();
      return result;
    } catch (error) {
      // Backgrounding is not terminal (the background continuation re-enters
      // run()), and a lease-acquisition loss means another runner owns the run
      // and will release the hold itself when it finishes.
      const keepsHold =
        error instanceof WorkflowRunBackgroundedError ||
        (error instanceof Error && error.message === `Workflow run is already active: ${runId}`);
      if (!keepsHold) {
        await this.taskAdapter.onRunEnded?.();
      }
      throw error;
    }
  }

  private async runWithLease(
    runId: string,
    options?: WorkflowRunnerRunOptions
  ): Promise<WorkflowResult> {
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
      const allowLegacyMissingOutputSchema = run.agentOutputSchemaRequired !== true;
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
              allowLegacyMissingOutputSchema,
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
        setupRuntime.registerFunction("__workflowParallelAgents", async (rawSpecs, rawOptions) => {
          try {
            return await this.runAgentStepsInParallel(runId, sequence, rawSpecs, {
              ignoreStartedTaskIds,
              allowLegacyMissingOutputSchema,
              waitOptions: getWorkflowAgentWaitOptions(setupRuntime, options),
              leaseGuard,
              rawOptions,
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
      allowLegacyMissingOutputSchema: boolean;
      waitOptions?: WorkflowAgentWaitOptions;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<StructuredTaskOutput> {
    const spec = parseWorkflowAgentSpec(rawSpec, {
      allowMissingOutputSchema: options.allowLegacyMissingOutputSchema,
    });
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
          title: spec.title,
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
      allowMissingOutputSchema: options.allowLegacyMissingOutputSchema,
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
      allowLegacyMissingOutputSchema: boolean;
      waitOptions?: WorkflowAgentWaitOptions;
      leaseGuard: WorkflowRunnerLeaseGuard;
      rawOptions?: unknown;
    }
  ): Promise<StructuredTaskOutput[]> {
    assert(Array.isArray(rawSpecs), "parallelAgents requires an array of agent specs");
    assert(rawSpecs.length > 0, "parallelAgents requires at least one agent spec");
    const { maxParallel } = parseParallelAgentsOptions(options.rawOptions);

    const results = new Array<StructuredTaskOutput>(rawSpecs.length);
    const parsedSteps = rawSpecs.map((rawSpec) => {
      const spec = parseWorkflowAgentSpec(rawSpec, {
        allowMissingOutputSchema: options.allowLegacyMissingOutputSchema,
      });
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
      allowMissingOutputSchema: boolean;
    }> = [];
    for (const [index, step] of parsedSteps.entries()) {
      const existingStep = existingSteps[index];
      if (existingStep?.status === "completed" && existingStep.result != null) {
        if (existingStep.taskId != null) {
          options.leaseGuard.throwIfLost();
          await this.recordTaskCompletedEventIfMissing(runId, sequence, {
            stepId: step.spec.id,
            taskId: existingStep.taskId,
            title: step.spec.title,
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
        allowMissingOutputSchema: options.allowLegacyMissingOutputSchema,
        attempt: 1,
      });
    }

    while (pending.length > 0) {
      const queued = pending;
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
      // A child-task failure aborts the batch the same way regardless of which
      // launch path raised it: a foreground-backgrounded wait flips the batch to
      // backgrounded and aborts it (so the abort guards drain queued work),
      // while any other failure interrupts the still-running siblings unless the
      // batch was already backgrounded. Shared by the per-run and bulk-create
      // catch blocks so the two stay in lockstep.
      const applyChildFailureToBatch = async (error: unknown): Promise<void> => {
        if (isForegroundWaitBackgroundedError(error)) {
          foregroundBackgrounded = true;
          abortBatch();
        } else if (!foregroundBackgrounded) {
          await interruptRemainingTasks();
        }
      };
      const batchWaitOptions: WorkflowAgentWaitOptions = {
        ...options.waitOptions,
        abortSignal: batchAbortController.signal,
      };
      // maxParallel caps live child tasks with a sliding window: the next spec
      // starts as soon as any running one finishes. Validation retries are
      // requeued at the front so a schema-only failure immediately uses the
      // freed slot instead of waiting for unrelated slow siblings to drain.
      const maxActive = maxParallel ?? queued.length;
      assert(maxActive > 0, "WorkflowRunner.parallelAgents maxActive must be positive");
      const usesWindow = maxParallel != null && maxParallel < queued.length;

      let batchFailed = false;
      const throwIfAbortPreventsQueuedWork = async (): Promise<void> => {
        if (queued.length === 0 || !batchAbortController.signal.aborted) {
          return;
        }
        if (foregroundBackgrounded) {
          throw createForegroundWaitBackgroundedError();
        }
        await interruptRemainingTasks();
        throw new Error(`parallelAgents aborted before launching ${queued.length} queued step(s)`);
      };

      // Under a window, tasks must be created lazily when a slot frees;
      // bulk-creating the whole wave up front would start every child at once.
      const createAgentTasks =
        !usesWindow &&
        this.taskAdapter.createAgentTasks != null &&
        this.taskAdapter.waitForAgentTask != null
          ? this.taskAdapter.createAgentTasks.bind(this.taskAdapter)
          : undefined;
      const bulkCreatableSteps =
        createAgentTasks != null ? queued.filter((step) => step.taskId == null) : [];
      let nextRunIndex = 0;
      const unsettledRuns = new Map<
        number,
        Promise<
          | {
              runIndex: number;
              step: (typeof queued)[number];
              runResult: WorkflowAgentRunResult;
            }
          | { runIndex: number; step: (typeof queued)[number]; error: unknown }
        >
      >();

      const startRun = (step: (typeof queued)[number]): void => {
        const runIndex = nextRunIndex;
        nextRunIndex += 1;
        const runSpec =
          step.attempt === 1
            ? step.spec
            : buildRetryAgentSpec(
                step.spec,
                step.attempt - 1,
                step.retryMessage ?? "previous attempt failed"
              );
        const run = (async () => {
          try {
            if (batchFailed || batchAbortController.signal.aborted) {
              throw new Error(
                `parallelAgents step ${step.spec.id} canceled before it started: a sibling task failed or the batch was aborted`
              );
            }
            const runResult = await this.runOrResumeAgentStep(runId, sequence, {
              spec: runSpec,
              inputHash: step.inputHash,
              startedAt: step.startedAt,
              taskId: step.taskId,
              allowMissingOutputSchema: step.allowMissingOutputSchema,
              leaseGuard: options.leaseGuard,
              waitOptions: batchWaitOptions,
            });
            return { runIndex, step, runResult };
          } catch (error) {
            batchFailed = true;
            await applyChildFailureToBatch(error);
            return { runIndex, step, error };
          }
        })();
        unsettledRuns.set(runIndex, run);
      };

      const launchAvailable = (): void => {
        while (
          !batchFailed &&
          !batchAbortController.signal.aborted &&
          unsettledRuns.size < maxActive &&
          queued.length > 0
        ) {
          const step = queued.shift();
          assert(step != null, "WorkflowRunner.parallelAgents queued step is required");
          startRun(step);
        }
      };

      try {
        await throwIfAbortPreventsQueuedWork();
        if (createAgentTasks != null && bulkCreatableSteps.length > 0) {
          try {
            const createdTasks = await createAgentTasks(
              bulkCreatableSteps.map((step) => step.spec),
              {
                onTaskCreated: async (index, taskId) => {
                  const step = bulkCreatableSteps[index];
                  assert(
                    step != null,
                    "WorkflowRunner.parallelAgents bulk lifecycle index mismatch"
                  );
                  assert(
                    taskId.length > 0,
                    "WorkflowRunner.parallelAgents bulk taskId is required"
                  );
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
                    title: step.spec.title,
                  });
                },
              }
            );
            if (createdTasks.length !== bulkCreatableSteps.length) {
              throw new Error(
                "parallelAgents bulk task creation returned the wrong number of tasks"
              );
            }
            for (const [index, createdTask] of createdTasks.entries()) {
              assert(
                createdTask.taskId.length > 0,
                "WorkflowRunner.parallelAgents created taskId is required"
              );
              bulkCreatableSteps[index].taskId = createdTask.taskId;
            }
          } catch (error) {
            await applyChildFailureToBatch(error);
            throw error;
          }
        }

        await throwIfAbortPreventsQueuedWork();
        launchAvailable();
        await throwIfAbortPreventsQueuedWork();
        while (unsettledRuns.size > 0) {
          const settled = await Promise.race(unsettledRuns.values());
          unsettledRuns.delete(settled.runIndex);
          if ("error" in settled) {
            await Promise.allSettled(unsettledRuns.values());
            if (foregroundBackgrounded) {
              throw createForegroundWaitBackgroundedError();
            }
            throw settled.error;
          }
          try {
            results[settled.step.index] = await this.recordAgentResult(runId, sequence, {
              spec: settled.runResult.resultSpec,
              inputHash: settled.step.inputHash,
              startedAt: settled.step.startedAt,
              leaseGuard: options.leaseGuard,
              rawResult: settled.runResult.rawResult,
            });
          } catch (error) {
            if (
              !isRetryableAgentOutputError(error) ||
              settled.step.attempt >= WORKFLOW_AGENT_MAX_ATTEMPTS
            ) {
              batchFailed = true;
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
            queued.unshift({
              ...settled.step,
              startedAt: this.clock.nowIso(),
              taskId: undefined,
              attempt: settled.step.attempt + 1,
              retryMessage: getErrorMessage(error),
            });
          }
          launchAvailable();
          await throwIfAbortPreventsQueuedWork();
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
      allowMissingOutputSchema: boolean;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<StructuredTaskOutput> {
    let attempt = 1;
    let startedAt = step.startedAt;
    let taskId = step.taskId;
    let spec = step.spec;
    while (attempt <= WORKFLOW_AGENT_MAX_ATTEMPTS) {
      const runResult = await this.runOrResumeAgentStep(runId, sequence, {
        spec,
        inputHash: step.inputHash,
        startedAt,
        taskId,
        allowMissingOutputSchema: step.allowMissingOutputSchema,
        leaseGuard: step.leaseGuard,
        waitOptions: step.waitOptions,
      });
      try {
        return await this.recordAgentResult(runId, sequence, {
          spec: runResult.resultSpec,
          inputHash: step.inputHash,
          startedAt,
          leaseGuard: step.leaseGuard,
          rawResult: runResult.rawResult,
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
      allowMissingOutputSchema: boolean;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<WorkflowAgentRunResult> {
    step.leaseGuard.throwIfLost();
    if (step.taskId != null && this.taskAdapter.waitForAgentTask != null) {
      await this.recordTaskStartedEventIfMissing(runId, sequence, {
        stepId: step.spec.id,
        taskId: step.taskId,
        title: step.spec.title,
      });
      try {
        const resultSpec = step.allowMissingOutputSchema
          ? omitWorkflowAgentOutputSchema(step.spec)
          : step.spec;
        const rawResult = await this.taskAdapter.waitForAgentTask(
          step.taskId,
          resultSpec,
          step.waitOptions
        );
        return { rawResult, resultSpec };
      } catch (error) {
        if (!isForegroundWaitBackgroundedError(error)) {
          step.leaseGuard.throwIfLost();
          await this.recordTaskTerminalEventIfMissing(runId, sequence, {
            stepId: step.spec.id,
            taskId: step.taskId,
            title: step.spec.title,
            status: getTaskTerminalStatusForError(error, step.waitOptions?.abortSignal),
          });
        }
        if (!shouldRestartUnrecoverableStartedTask(error)) {
          throw error;
        }
      }
    }

    const resultSpec = normalizeWorkflowAgentSpecForExecution(step.spec, {
      allowMissingOutputSchema: step.allowMissingOutputSchema,
    });
    step.leaseGuard.throwIfLost();
    let recordedTaskId: string | undefined;
    let rawResult: WorkflowAgentResult;
    try {
      rawResult = await this.taskAdapter.runAgent(
        resultSpec,
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
              title: step.spec.title,
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
          title: step.spec.title,
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
        title: step.spec.title,
      });
    }
    return { rawResult, resultSpec };
  }

  private async recordTaskStartedEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    task: { stepId: string; taskId: string; title?: string }
  ): Promise<void> {
    await this.recordTaskEventIfMissing(runId, sequence, { ...task, status: "started" });
  }

  private async recordTaskCompletedEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    task: { stepId: string; taskId: string; title?: string }
  ): Promise<void> {
    await this.recordTaskEventIfMissing(runId, sequence, { ...task, status: "completed" });
  }

  private async recordTaskTerminalEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    task: { stepId: string; taskId: string; title?: string; status: "failed" | "interrupted" }
  ): Promise<void> {
    await this.recordTaskEventIfMissing(runId, sequence, task);
  }

  private async recordTaskEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    task: { stepId: string; taskId: string; title?: string; status: string }
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
        title: task.title,
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
      if (!Object.hasOwn(result, "structuredOutput") || result.structuredOutput === undefined) {
        const message = `agent ${step.spec.id} structured output failed schema validation: $.structuredOutput: Required property is missing`;
        await this.recordFailedAgentAttempt(runId, sequence, step, message);
        throw new WorkflowAgentOutputValidationError(message);
      }
      const validation = validateJsonSchemaSubset(step.spec.outputSchema, result.structuredOutput);
      if (!validation.success) {
        const message = `agent ${step.spec.id} structured output failed schema validation: ${formatJsonSchemaValidationErrors(validation.errors)}`;
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
        title: step.spec.title,
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
        title: step.spec.title,
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
  const allowedPathPrefixes = spec.allowedPathPrefixes ?? spec.allowed_path_prefixes;
  if (allowedPathPrefixes !== undefined) {
    assert(Array.isArray(allowedPathPrefixes), "applyPatch allowedPathPrefixes must be an array");
    parsed.allowedPathPrefixes = allowedPathPrefixes.map((prefix) => {
      assert(
        typeof prefix === "string" && prefix.trim().length > 0,
        "applyPatch allowedPathPrefixes entries must be non-empty strings"
      );
      return prefix.trim();
    });
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

function normalizeWorkflowAgentSpecForExecution(
  spec: WorkflowAgentSpec,
  options: { allowMissingOutputSchema: boolean }
): WorkflowAgentSpec {
  if (!options.allowMissingOutputSchema) {
    return spec;
  }
  if (spec.outputSchema === undefined) {
    return { ...spec, outputSchema: {} };
  }
  const outputSchemaValidation = validateJsonSchemaSubsetSchema(spec.outputSchema);
  return outputSchemaValidation.success ? spec : omitWorkflowAgentOutputSchema(spec);
}

function omitWorkflowAgentOutputSchema(spec: WorkflowAgentSpec): WorkflowAgentSpec {
  const { outputSchema: _outputSchema, ...schemaLessSpec } = spec;
  return schemaLessSpec;
}

function validateWorkflowAgentOutputSchema(stepId: string, outputSchema: unknown): void {
  const outputSchemaValidation = validateJsonSchemaSubsetSchema(outputSchema);
  if (!outputSchemaValidation.success) {
    throw new Error(
      `Workflow agent step ${stepId} has invalid outputSchema: ${formatJsonSchemaValidationErrors(
        outputSchemaValidation.errors
      )}`
    );
  }
}

function parseWorkflowAgentSpec(
  rawSpec: unknown,
  options: { allowMissingOutputSchema: boolean }
): WorkflowAgentSpec {
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
  if (spec.isolation !== undefined) {
    assert(
      spec.isolation === "fork" || spec.isolation === "none",
      'agent isolation must be "fork" or "none"'
    );
    parsed.isolation = spec.isolation;
  }
  if (spec.outputSchema === undefined) {
    assert(
      options.allowMissingOutputSchema,
      `Workflow agent step ${parsed.id} must declare outputSchema`
    );
  } else {
    if (!options.allowMissingOutputSchema) {
      validateWorkflowAgentOutputSchema(parsed.id, spec.outputSchema);
    }
    parsed.outputSchema = spec.outputSchema;
  }
  if (spec.onRefusal !== undefined) {
    assert(
      spec.onRefusal === "fail" || spec.onRefusal === "fallback",
      'agent onRefusal must be "fail" or "fallback"'
    );
    parsed.onRefusal = spec.onRefusal;
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
  const withoutCommonJsMetadata = removeCommonJsWorkflowMetadataDeclaration(source);
  const withoutNamedExports = withoutCommonJsMetadata.replace(
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
${WORKFLOW_RUNTIME_STDLIB_SOURCE}
${compiled}
return (async () => await __muxWorkflow({
  args: __workflowArgs(),
  phase: __workflowPhase,
  log: __workflowLog,
  agent: __workflowAgent,
  applyPatch: __workflowApplyPatch,
  parallelAgents: __workflowParallelAgents,
}))();
`;
}
