import { StructuredTaskOutputSchema, WorkflowResultSchema } from "@/common/orpc/schemas";
import type {
  StructuredTaskOutput,
  WorkflowResult,
  WorkflowRunEvent,
} from "@/common/types/workflow";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { validateJsonSchemaSubset } from "@/common/utils/jsonSchemaSubset";
import type { IJSRuntime, IJSRuntimeFactory } from "@/node/services/ptc/runtime";
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

export interface WorkflowTaskAdapter {
  runAgent(
    spec: WorkflowAgentSpec,
    lifecycle?: { onTaskCreated?: (taskId: string) => Promise<void> | void },
    waitOptions?: WorkflowAgentWaitOptions
  ): Promise<WorkflowAgentResult>;
  waitForAgentTask?(
    taskId: string,
    spec: WorkflowAgentSpec,
    waitOptions?: WorkflowAgentWaitOptions
  ): Promise<WorkflowAgentResult>;
  interruptRun?(): Promise<void>;
}

export interface WorkflowRunnerRunOptions {
  onLeaseAcquired?: () => void;
  abortSignal?: AbortSignal;
  backgroundOnMessageQueued?: boolean;
  allowResumeFromInterrupted?: boolean;
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

function shouldRestartUnrecoverableStartedTask(error: unknown): boolean {
  const message = getErrorMessage(error);
  return message === "Task not found" || message === "Task interrupted";
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
      if (resumingInterruptedRun && options?.allowResumeFromInterrupted !== true) {
        throw new Error(`Workflow run interrupted: ${runId}`);
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
        { allowInterruptedResume: resumingInterruptedRun }
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
    return await this.runStore.appendEvent(runId, event, {
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
      const pendingRuns = currentPending.map(async (step) => {
        return await this.runOrResumeAgentStep(runId, {
          spec:
            step.attempt === 1
              ? step.spec
              : buildRetryAgentSpec(
                  step.spec,
                  step.attempt - 1,
                  step.retryMessage ?? "previous attempt failed"
                ),
          inputHash: step.inputHash,
          startedAt: step.startedAt,
          taskId: step.taskId,
          leaseGuard: options.leaseGuard,
          waitOptions: batchWaitOptions,
        });
      });
      const guardedRuns = pendingRuns.map(async (pendingRun) => {
        try {
          return await pendingRun;
        } catch (error) {
          if (isForegroundWaitBackgroundedError(error)) {
            foregroundBackgrounded = true;
            abortBatch();
          } else if (!foregroundBackgrounded) {
            await interruptRemainingTasks();
          }
          throw error;
        }
      });
      let rawResults: WorkflowAgentResult[];
      try {
        rawResults = await Promise.all(guardedRuns);
      } catch (error) {
        await Promise.allSettled(guardedRuns);
        if (foregroundBackgrounded) {
          throw createForegroundWaitBackgroundedError();
        }
        throw error;
      } finally {
        upstreamAbortSignal?.removeEventListener("abort", abortBatch);
      }
      for (const [pendingIndex, rawResult] of rawResults.entries()) {
        const step = currentPending[pendingIndex];
        assert(step != null, "WorkflowRunner.runAgentStepsInParallel: missing pending step");
        try {
          results[step.index] = await this.recordAgentResult(runId, sequence, {
            ...step,
            leaseGuard: options.leaseGuard,
            rawResult,
          });
        } catch (error) {
          if (!isRetryableAgentOutputError(error) || step.attempt >= WORKFLOW_AGENT_MAX_ATTEMPTS) {
            throw error;
          }
          options.leaseGuard.throwIfLost();
          await this.recordAgentRetry(runId, sequence, step.spec.id, step.attempt, error);
          pending.push({
            ...step,
            startedAt: this.clock.nowIso(),
            taskId: undefined,
            attempt: step.attempt + 1,
            retryMessage: getErrorMessage(error),
          });
        }
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
      const rawResult = await this.runOrResumeAgentStep(runId, {
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
      try {
        return await this.taskAdapter.waitForAgentTask(step.taskId, step.spec, step.waitOptions);
      } catch (error) {
        if (!shouldRestartUnrecoverableStartedTask(error)) {
          throw error;
        }
      }
    }

    step.leaseGuard.throwIfLost();
    let recordedTaskId: string | undefined;
    const rawResult = await this.taskAdapter.runAgent(
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
        },
      },
      step.waitOptions
    );
    step.leaseGuard.throwIfLost();
    if (recordedTaskId == null) {
      await this.recordStepStarted(runId, {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId: rawResult.taskId,
        startedAt: step.startedAt,
      });
    }
    return rawResult;
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
    await this.recordStepCompleted(runId, {
      stepId: step.spec.id,
      inputHash: step.inputHash,
      taskId,
      result,
      startedAt: step.startedAt,
      completedAt: this.clock.nowIso(),
    });
    step.leaseGuard.throwIfLost();
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "task",
      at: this.clock.nowIso(),
      stepId: step.spec.id,
      taskId,
      status: "completed",
    });
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
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "validation",
      at: this.clock.nowIso(),
      stepId: step.spec.id,
      success: false,
      message,
    });
    step.leaseGuard.throwIfLost();
    await this.recordStepFailed(runId, {
      stepId: step.spec.id,
      inputHash: step.inputHash,
      taskId,
      error: message,
      startedAt: step.startedAt,
      completedAt: this.clock.nowIso(),
    });
    if (taskId != null) {
      step.leaseGuard.throwIfLost();
      await this.appendEvent(runId, {
        sequence: sequence.next(),
        type: "task",
        at: this.clock.nowIso(),
        stepId: step.spec.id,
        taskId,
        status: "failed",
      });
    }
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
  const compiled = source.replace(
    /export\s+default\s+(async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/u,
    (_match, asyncKeyword: string | undefined) => `${asyncKeyword ?? ""}function __muxWorkflow(`
  );
  assert(compiled !== source, "Workflow definition must export a default function");

  return `
Date = undefined;
Math.random = undefined;
${compiled}
return (async () => await __muxWorkflow({
  args: __workflowArgs(),
  phase: __workflowPhase,
  log: __workflowLog,
  agent: __workflowAgent,
  parallelAgents: __workflowParallelAgents,
}))();
`;
}
