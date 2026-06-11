import * as crypto from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import writeFileAtomic from "write-file-atomic";

import {
  WorkflowEventSequenceSchema,
  WorkflowRunEventSchema,
  WorkflowRunIdSchema,
  WorkflowRunRecordSchema,
  WorkflowStepRecordSchema,
} from "@/common/orpc/schemas";
import type {
  StructuredTaskOutput,
  WorkflowDefinitionDescriptor,
  WorkflowRunEvent,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStepRecord,
} from "@/common/types/workflow";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";

export interface WorkflowRunStoreOptions {
  sessionDir: string;
  staleLeaseMs?: number;
}

export interface CreateWorkflowRunInput {
  id: string;
  workspaceId: string;
  definition: WorkflowDefinitionDescriptor;
  definitionSource: string;
  args: unknown;
  defaultActionCwd?: string;
  now: string;
}

export interface AppendWorkflowRunEventOptions {
  /**
   * Only explicit Resume may reopen an interrupted run; stale active runners must preserve the
   * interrupt.
   */
  allowInterruptedResume?: boolean;
  /** Only explicit failed-run checkpoint retry may reopen a failed run. */
  allowFailedCheckpointRetry?: boolean;
  /** Fence a journal/step mutation so only the current lease owner can write it. */
  expectedLeaseOwnerId?: string;
}

type WorkflowRunEventDraft = WorkflowRunEvent extends infer Event
  ? Event extends WorkflowRunEvent
    ? Omit<Event, "sequence">
    : never
  : never;

interface LeaseRecord {
  ownerId: string;
  acquiredAtMs: number;
}

interface WorkflowStepLookup {
  stepId: string;
  inputHash: string;
}

export class WorkflowRunStore {
  private readonly sessionDir: string;
  private readonly staleLeaseMs: number;

  constructor(options: WorkflowRunStoreOptions) {
    assert(options.sessionDir.length > 0, "WorkflowRunStore: sessionDir is required");
    this.sessionDir = options.sessionDir;
    this.staleLeaseMs = options.staleLeaseMs ?? 30_000;
  }

  async createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunRecord> {
    assert(input.id.length > 0, "WorkflowRunStore.createRun: id is required");
    assert(input.workspaceId.length > 0, "WorkflowRunStore.createRun: workspaceId is required");
    assert(
      input.definitionSource.length > 0,
      "WorkflowRunStore.createRun: definitionSource is required"
    );

    const runDir = this.runDir(input.id);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "definition.js"), input.definitionSource, "utf-8");
    await fs.writeFile(path.join(runDir, "events.jsonl"), "", { flag: "a" });
    await fs.writeFile(path.join(runDir, "steps.jsonl"), "", { flag: "a" });

    const run = WorkflowRunRecordSchema.parse({
      id: input.id,
      workspaceId: input.workspaceId,
      definition: input.definition,
      definitionSource: input.definitionSource,
      definitionHash: hashSource(input.definitionSource),
      args: input.args,
      ...(input.defaultActionCwd != null ? { defaultActionCwd: input.defaultActionCwd } : {}),
      status: "pending",
      createdAt: input.now,
      updatedAt: input.now,
      events: [],
      steps: [],
    });

    await this.writeRunFile(input.id, run);
    return run;
  }

  async getRun(runId: string): Promise<WorkflowRunRecord> {
    // UI polling must not wait behind the writer lock; while a mutation is in progress,
    // fall back to the last atomic run.json snapshot instead of reading half-updated journals.
    if (await this.hasActiveWorkflowMutationLock(runId)) {
      return await this.getRunFileSnapshot(runId);
    }
    return await this.getRunUnlocked(runId);
  }

  async listRuns(): Promise<WorkflowRunRecord[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.workflowsDir(), { withFileTypes: true });
    } catch {
      return [];
    }

    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry): Promise<WorkflowRunRecord | null> => {
          try {
            return await this.getRun(entry.name);
          } catch (error) {
            log.warn(`Skipping unreadable workflow run '${entry.name}': ${getErrorMessage(error)}`);
            return null;
          }
        })
    );

    return runs
      .filter((run): run is WorkflowRunRecord => run != null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async appendNextEvent(
    runId: string,
    event: WorkflowRunEventDraft,
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<WorkflowRunRecord> {
    assert(runId.length > 0, "WorkflowRunStore.appendNextEvent: runId is required");
    const eventWithMaybeSequence = event as WorkflowRunEventDraft & { sequence?: unknown };
    assert(
      eventWithMaybeSequence.sequence == null,
      "WorkflowRunStore.appendNextEvent: event sequence is assigned by the store"
    );
    return await this.withWorkflowMutationLock(
      runId,
      async () =>
        await this.withExpectedLeaseOwner(
          runId,
          options.expectedLeaseOwnerId,
          async () => await this.appendNextEventUnlocked(runId, event, options)
        )
    );
  }

  async appendEvent(
    runId: string,
    event: WorkflowRunEvent,
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<WorkflowRunRecord> {
    return await this.withWorkflowMutationLock(
      runId,
      async () =>
        await this.withExpectedLeaseOwner(
          runId,
          options.expectedLeaseOwnerId,
          async () => await this.appendEventUnlocked(runId, event, options)
        )
    );
  }

  async appendStatus(
    runId: string,
    status: WorkflowRunStatus,
    at: string,
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<WorkflowRunRecord> {
    return await this.appendNextEvent(runId, { type: "status", at, status }, options);
  }

  async recordStepStarted(
    runId: string,
    input: {
      stepId: string;
      inputHash: string;
      taskId?: string;
      startedAt: string;
    },
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<void> {
    await this.appendStepRecord(
      runId,
      {
        stepId: input.stepId,
        inputHash: input.inputHash,
        taskId: input.taskId,
        startedAt: input.startedAt,
        status: "started",
      },
      options
    );
  }

  async recordStepCompleted(
    runId: string,
    input: {
      stepId: string;
      inputHash: string;
      taskId?: string;
      result: StructuredTaskOutput;
      startedAt: string;
      completedAt: string;
    },
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<void> {
    await this.appendStepRecord(
      runId,
      {
        stepId: input.stepId,
        inputHash: input.inputHash,
        taskId: input.taskId,
        result: input.result,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        status: "completed",
      },
      options
    );
  }

  async recordStepCompletedAndAppendTaskEvent(
    runId: string,
    input: {
      stepId: string;
      inputHash: string;
      taskId?: string;
      // Agent-spec title for the task event row; distinct from result.title,
      // which is the sub-agent's self-reported report title.
      title?: string;
      result: StructuredTaskOutput;
      startedAt: string;
      completedAt: string;
    },
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<void> {
    // Fail fast on empty titles: the event schema enforces min(1), and letting it
    // surface as a ZodError mid-write would abort step persistence with a less
    // actionable error.
    assert(
      input.title == null || input.title.length > 0,
      "WorkflowRunStore.recordStepCompletedAndAppendTaskEvent: title must be non-empty when provided"
    );
    await this.withWorkflowMutationLock(runId, async () => {
      await this.withExpectedLeaseOwner(runId, options.expectedLeaseOwnerId, async () => {
        const record = WorkflowStepRecordSchema.parse({
          stepId: input.stepId,
          inputHash: input.inputHash,
          taskId: input.taskId,
          result: input.result,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
          status: "completed",
        });
        const run = await this.getRunUnlocked(runId);
        this.assertCanAppendStepRecord(runId, run);

        let updatedRun = this.withStepRecord(run, record);
        const eventsToAppend: WorkflowRunEvent[] = [];
        if (
          input.taskId != null &&
          !updatedRun.events.some(
            (event) =>
              event.type === "task" &&
              event.status === "completed" &&
              event.stepId === input.stepId &&
              event.taskId === input.taskId
          )
        ) {
          const event = this.createNextEventForRun(
            runId,
            updatedRun,
            {
              type: "task",
              at: input.completedAt,
              stepId: input.stepId,
              taskId: input.taskId,
              status: "completed",
              title: input.title,
            },
            options
          );
          eventsToAppend.push(event);
          updatedRun = this.withEvent(updatedRun, event);
        }

        await appendJsonLine(this.stepsFile(runId), record);
        await appendJsonLines(this.eventsFile(runId), eventsToAppend);
        await this.writeRunFile(runId, updatedRun);
      });
    });
  }

  async recordStepFailedAndAppendTaskEvent(
    runId: string,
    input: {
      stepId: string;
      inputHash: string;
      taskId?: string;
      // Agent-spec title for the task event row (see recordStepCompletedAndAppendTaskEvent).
      title?: string;
      error: string;
      startedAt: string;
      completedAt: string;
      validationAt: string;
      taskFailedAt?: string;
    },
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<void> {
    assert(
      input.title == null || input.title.length > 0,
      "WorkflowRunStore.recordStepFailedAndAppendTaskEvent: title must be non-empty when provided"
    );
    await this.withWorkflowMutationLock(runId, async () => {
      await this.withExpectedLeaseOwner(runId, options.expectedLeaseOwnerId, async () => {
        const record = WorkflowStepRecordSchema.parse({
          stepId: input.stepId,
          inputHash: input.inputHash,
          taskId: input.taskId,
          error: input.error,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
          status: "failed",
        });
        const run = await this.getRunUnlocked(runId);
        this.assertCanAppendStepRecord(runId, run);

        const validationEvent = this.createNextEventForRun(
          runId,
          run,
          {
            type: "validation",
            at: input.validationAt,
            stepId: input.stepId,
            success: false,
            message: input.error,
          },
          options
        );
        let updatedRun = this.withEvent(run, validationEvent);
        updatedRun = this.withStepRecord(updatedRun, record);
        const eventsToAppend: WorkflowRunEvent[] = [validationEvent];
        if (
          input.taskId != null &&
          !updatedRun.events.some(
            (event) =>
              event.type === "task" &&
              event.status === "failed" &&
              event.stepId === input.stepId &&
              event.taskId === input.taskId
          )
        ) {
          const taskEvent = this.createNextEventForRun(
            runId,
            updatedRun,
            {
              type: "task",
              at: input.taskFailedAt ?? input.completedAt,
              stepId: input.stepId,
              taskId: input.taskId,
              status: "failed",
              title: input.title,
            },
            options
          );
          eventsToAppend.push(taskEvent);
          updatedRun = this.withEvent(updatedRun, taskEvent);
        }

        await appendJsonLine(this.stepsFile(runId), record);
        await appendJsonLines(this.eventsFile(runId), eventsToAppend);
        await this.writeRunFile(runId, updatedRun);
      });
    });
  }

  async appendTaskEventIfMissing(
    runId: string,
    // title is the agent-spec title for the task event row (see recordStepCompletedAndAppendTaskEvent).
    task: { stepId: string; taskId: string; status: string; at: string; title?: string },
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<void> {
    assert(task.stepId.length > 0, "WorkflowRunStore.appendTaskEventIfMissing: stepId is required");
    assert(task.taskId.length > 0, "WorkflowRunStore.appendTaskEventIfMissing: taskId is required");
    assert(task.status.length > 0, "WorkflowRunStore.appendTaskEventIfMissing: status is required");
    assert(
      task.title == null || task.title.length > 0,
      "WorkflowRunStore.appendTaskEventIfMissing: title must be non-empty when provided"
    );
    await this.withWorkflowMutationLock(runId, async () => {
      await this.withExpectedLeaseOwner(runId, options.expectedLeaseOwnerId, async () => {
        const run = await this.getRunUnlocked(runId);
        const alreadyRecorded = run.events.some(
          (event) =>
            event.type === "task" &&
            event.status === task.status &&
            event.stepId === task.stepId &&
            event.taskId === task.taskId
        );
        if (alreadyRecorded) {
          return;
        }
        const event = this.createNextEventForRun(
          runId,
          run,
          {
            type: "task",
            at: task.at,
            stepId: task.stepId,
            taskId: task.taskId,
            status: task.status,
            title: task.title,
          },
          options
        );
        await appendJsonLine(this.eventsFile(runId), event);
        await this.writeRunFile(runId, this.withEvent(run, event));
      });
    });
  }

  async recordStepFailed(
    runId: string,
    input: {
      stepId: string;
      inputHash: string;
      taskId?: string;
      error: string;
      startedAt: string;
      completedAt: string;
    },
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<void> {
    await this.appendStepRecord(
      runId,
      {
        stepId: input.stepId,
        inputHash: input.inputHash,
        taskId: input.taskId,
        error: input.error,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        status: "failed",
      },
      options
    );
  }

  async getStep(
    runId: string,
    stepId: string,
    inputHash: string
  ): Promise<WorkflowStepRecord | null> {
    const [step] = await this.getSteps(runId, [{ stepId, inputHash }]);
    return step ?? null;
  }

  async getCompletedStep(
    runId: string,
    stepId: string,
    inputHash: string
  ): Promise<WorkflowStepRecord | null> {
    const step = await this.getStep(runId, stepId, inputHash);
    return step?.status === "completed" ? step : null;
  }

  async getSteps(
    runId: string,
    lookups: readonly WorkflowStepLookup[]
  ): Promise<Array<WorkflowStepRecord | null>> {
    if (lookups.length === 0) {
      return [];
    }
    const requestedKeys = new Set(lookups.map(getWorkflowStepKey));
    const byKey = new Map<string, WorkflowStepRecord>();
    for (const step of await this.readSteps(runId)) {
      const key = getWorkflowStepKey(step);
      if (requestedKeys.has(key)) {
        byKey.set(key, step);
      }
    }
    return lookups.map((lookup) => byKey.get(getWorkflowStepKey(lookup)) ?? null);
  }

  async acquireLease(runId: string, ownerId: string, nowMs = Date.now()): Promise<boolean> {
    assert(ownerId.length > 0, "WorkflowRunStore.acquireLease: ownerId is required");
    const leaseFile = this.leaseFile(runId);
    const lockDir = `${leaseFile}.lock`;
    if (!(await acquireLeaseMutationLock(lockDir, Date.now(), this.leaseMutationLockStaleMs()))) {
      return false;
    }

    try {
      const existing = await readLease(leaseFile);
      if (existing != null && nowMs - existing.acquiredAtMs <= this.staleLeaseMs) {
        return false;
      }

      await fs.mkdir(this.runDir(runId), { recursive: true });
      await writeJsonAtomic(leaseFile, { ownerId, acquiredAtMs: nowMs } satisfies LeaseRecord);
      return true;
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }

  async getLeaseRetryDelayMs(runId: string, nowMs = Date.now()): Promise<number> {
    const lease = await readLease(this.leaseFile(runId));
    if (lease == null) {
      return 0;
    }
    const remainingMs = this.staleLeaseMs - (nowMs - lease.acquiredAtMs);
    return Math.max(0, Math.ceil(remainingMs) + 1);
  }

  getLeaseRenewalIntervalMs(): number {
    return Math.max(1, Math.floor(this.staleLeaseMs / 2));
  }

  private leaseMutationLockStaleMs(): number {
    return Math.max(1_000, this.staleLeaseMs);
  }

  private leaseMutationWaitTimeoutMs(): number {
    return Math.max(4_000, this.leaseMutationLockStaleMs() * 4);
  }

  async renewLease(runId: string, ownerId: string, nowMs = Date.now()): Promise<boolean> {
    assert(ownerId.length > 0, "WorkflowRunStore.renewLease: ownerId is required");
    const leaseFile = this.leaseFile(runId);
    const lockDir = `${leaseFile}.lock`;
    try {
      await acquireWorkflowMutationLock(
        lockDir,
        this.leaseMutationLockStaleMs(),
        this.leaseMutationWaitTimeoutMs()
      );
    } catch {
      return false;
    }

    try {
      const existing = await readLease(leaseFile);
      if (existing?.ownerId !== ownerId) {
        return false;
      }
      await writeJsonAtomic(leaseFile, { ownerId, acquiredAtMs: nowMs } satisfies LeaseRecord);
      return true;
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }

  async releaseLease(runId: string, ownerId: string): Promise<void> {
    const leaseFile = this.leaseFile(runId);
    const lockDir = `${leaseFile}.lock`;
    await acquireWorkflowMutationLock(
      lockDir,
      this.leaseMutationLockStaleMs(),
      this.leaseMutationWaitTimeoutMs()
    );

    try {
      const existing = await readLease(leaseFile);
      if (existing?.ownerId === ownerId) {
        await fs.rm(leaseFile, { force: true });
      }
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }

  private async withWorkflowMutationLock<T>(runId: string, mutation: () => Promise<T>): Promise<T> {
    const lockDir = `${this.eventsFile(runId)}.lock`;
    await acquireWorkflowMutationLock(
      lockDir,
      this.leaseMutationLockStaleMs(),
      this.leaseMutationWaitTimeoutMs()
    );
    try {
      return await mutation();
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }

  private async withExpectedLeaseOwner<T>(
    runId: string,
    expectedLeaseOwnerId: string | undefined,
    mutation: () => Promise<T>
  ): Promise<T> {
    if (expectedLeaseOwnerId == null) {
      return await mutation();
    }
    assert(
      expectedLeaseOwnerId.length > 0,
      "WorkflowRunStore: expected lease owner id must be non-empty"
    );
    const leaseFile = this.leaseFile(runId);
    const lockDir = `${leaseFile}.lock`;
    await acquireWorkflowMutationLock(
      lockDir,
      this.leaseMutationLockStaleMs(),
      this.leaseMutationWaitTimeoutMs()
    );
    try {
      const lease = await readLease(leaseFile);
      if (lease?.ownerId !== expectedLeaseOwnerId) {
        throw new Error(`Workflow run lease lost: ${runId}`);
      }
      return await mutation();
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }

  private async hasActiveWorkflowMutationLock(runId: string): Promise<boolean> {
    try {
      const stat = await fs.stat(`${this.eventsFile(runId)}.lock`);
      return Date.now() - stat.mtimeMs <= this.leaseMutationLockStaleMs();
    } catch {
      return false;
    }
  }

  private async getRunFileSnapshot(runId: string): Promise<WorkflowRunRecord> {
    const rawRun = JSON.parse(await fs.readFile(this.runFile(runId), "utf-8")) as unknown;
    const run = WorkflowRunRecordSchema.parse(rawRun);
    const definitionSource = await fs.readFile(
      path.join(this.runDir(runId), "definition.js"),
      "utf-8"
    );
    return WorkflowRunRecordSchema.parse({
      ...run,
      definitionSource,
      definitionHash: hashSource(definitionSource),
    });
  }

  private async getRunUnlocked(runId: string): Promise<WorkflowRunRecord> {
    const rawRun = JSON.parse(await fs.readFile(this.runFile(runId), "utf-8")) as unknown;
    const partial = WorkflowRunRecordSchema.omit({ events: true, steps: true }).parse(rawRun);
    const definitionSource = await fs.readFile(
      path.join(this.runDir(runId), "definition.js"),
      "utf-8"
    );
    const events = await this.readEvents(runId);
    const steps = await this.readSteps(runId);

    const latestEvent = events.at(-1);
    const status = getRunStatusFromEvents(events) ?? partial.status;
    return WorkflowRunRecordSchema.parse({
      ...partial,
      definitionSource,
      definitionHash: hashSource(definitionSource),
      status,
      updatedAt: latestEvent?.at ?? partial.updatedAt,
      events,
      steps,
    });
  }

  private async appendNextEventUnlocked(
    runId: string,
    event: WorkflowRunEventDraft,
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<WorkflowRunRecord> {
    const run = await this.getRunUnlocked(runId);
    const parsedEvent = this.createNextEventForRun(runId, run, event, options);
    await appendJsonLine(this.eventsFile(runId), parsedEvent);
    const updatedRun = this.withEvent(run, parsedEvent);
    await this.writeRunFile(runId, updatedRun);
    return updatedRun;
  }

  private async appendEventUnlocked(
    runId: string,
    event: WorkflowRunEvent,
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<WorkflowRunRecord> {
    const run = await this.getRunUnlocked(runId);
    const parsedEvent = WorkflowRunEventSchema.parse(event);
    this.assertCanAppendEvent(runId, run, parsedEvent, options);
    await appendJsonLine(this.eventsFile(runId), parsedEvent);
    const updatedRun = this.withEvent(run, parsedEvent);
    await this.writeRunFile(runId, updatedRun);
    return updatedRun;
  }

  private createNextEventForRun(
    runId: string,
    run: WorkflowRunRecord,
    event: WorkflowRunEventDraft,
    options: AppendWorkflowRunEventOptions = {}
  ): WorkflowRunEvent {
    const parsedEvent = WorkflowRunEventSchema.parse({
      ...event,
      sequence: (run.events.at(-1)?.sequence ?? 0) + 1,
    });
    this.assertCanAppendEvent(runId, run, parsedEvent, options);
    return parsedEvent;
  }

  private assertCanAppendEvent(
    runId: string,
    run: WorkflowRunRecord,
    event: WorkflowRunEvent,
    options: AppendWorkflowRunEventOptions
  ): void {
    const ordered = WorkflowEventSequenceSchema.safeParse([...run.events, event]);
    if (!ordered.success) {
      throw new Error(`Workflow events must be strictly ordered: ${ordered.error.message}`);
    }

    const isInterruptedResumeEvent =
      event.type === "status" &&
      options.allowInterruptedResume === true &&
      event.status === "running";
    const isFailedCheckpointRetryEvent =
      event.type === "status" &&
      options.allowFailedCheckpointRetry === true &&
      run.status === "failed" &&
      event.status === "running";
    const isRepeatedInterruptedStatus = event.type === "status" && event.status === "interrupted";
    if (run.status === "interrupted" && !isInterruptedResumeEvent && !isRepeatedInterruptedStatus) {
      throw new Error(`Workflow run interrupted: ${runId}`);
    }
    if (
      event.type === "status" &&
      isTerminalRunStatus(run.status) &&
      !isFailedCheckpointRetryEvent
    ) {
      throw new Error(`Cannot transition workflow run from ${run.status} to ${event.status}`);
    }
  }

  private assertCanAppendStepRecord(runId: string, run: WorkflowRunRecord): void {
    if (run.status === "interrupted") {
      throw new Error(`Workflow run interrupted: ${runId}`);
    }
  }

  private withEvent(run: WorkflowRunRecord, event: WorkflowRunEvent): WorkflowRunRecord {
    return WorkflowRunRecordSchema.parse({
      ...run,
      events: [...run.events, event],
      status: event.type === "status" ? event.status : run.status,
      updatedAt: event.at,
    });
  }

  private withStepRecord(run: WorkflowRunRecord, record: WorkflowStepRecord): WorkflowRunRecord {
    return WorkflowRunRecordSchema.parse({
      ...run,
      steps: mergeWorkflowStepRecords(run.steps, record),
    });
  }

  private async readEvents(runId: string): Promise<WorkflowRunEvent[]> {
    const events = await readJsonLines(this.eventsFile(runId), WorkflowRunEventSchema);
    return WorkflowEventSequenceSchema.parse(events);
  }

  private async readSteps(runId: string): Promise<WorkflowStepRecord[]> {
    const records = await readJsonLines(this.stepsFile(runId), WorkflowStepRecordSchema);
    return mergeWorkflowStepRecords(records);
  }

  private async appendStepRecord(
    runId: string,
    record: unknown,
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<void> {
    await this.withWorkflowMutationLock(runId, async () => {
      await this.withExpectedLeaseOwner(runId, options.expectedLeaseOwnerId, async () => {
        const parsedRecord = WorkflowStepRecordSchema.parse(record);
        const run = await this.getRunUnlocked(runId);
        this.assertCanAppendStepRecord(runId, run);
        await appendJsonLine(this.stepsFile(runId), parsedRecord);
      });
    });
  }

  private async writeRunFile(runId: string, run: WorkflowRunRecord): Promise<void> {
    const runForDisk = WorkflowRunRecordSchema.parse(run);
    await writeJsonAtomic(this.runFile(runId), runForDisk);
  }

  getStepArtifactsDir(runId: string, stepId: string, inputHash: string): string {
    assertValidWorkflowRunId(runId);
    assert(stepId.length > 0, "WorkflowRunStore.getStepArtifactsDir: stepId is required");
    assert(inputHash.length > 0, "WorkflowRunStore.getStepArtifactsDir: inputHash is required");
    const stepKey = crypto.createHash("sha256").update(`${stepId}\0${inputHash}`).digest("hex");
    return path.join(this.runDir(runId), "artifacts", stepKey);
  }

  private workflowsDir(): string {
    return path.join(this.sessionDir, "workflows");
  }

  private runDir(runId: string): string {
    assertValidWorkflowRunId(runId);
    return path.join(this.workflowsDir(), runId);
  }

  private runFile(runId: string): string {
    return path.join(this.runDir(runId), "run.json");
  }

  private eventsFile(runId: string): string {
    return path.join(this.runDir(runId), "events.jsonl");
  }

  private stepsFile(runId: string): string {
    return path.join(this.runDir(runId), "steps.jsonl");
  }

  private leaseFile(runId: string): string {
    return path.join(this.runDir(runId), "lease.json");
  }
}

// API callers provide run IDs when reading/resuming; validate before path joins so a malformed
// ID cannot escape the workspace-scoped workflows directory.
function assertValidWorkflowRunId(runId: string): void {
  assert(
    WorkflowRunIdSchema.safeParse(runId).success,
    "WorkflowRunStore: runId must match wfr_[A-Za-z0-9_-]+"
  );
}

function getWorkflowStepKey(step: WorkflowStepLookup): string {
  return `${step.stepId}\0${step.inputHash}`;
}

function mergeWorkflowStepRecords(
  records: readonly WorkflowStepRecord[],
  nextRecord?: WorkflowStepRecord
): WorkflowStepRecord[] {
  const byKey = new Map<string, WorkflowStepRecord>();
  for (const record of records) {
    byKey.set(getWorkflowStepKey(record), record);
  }
  if (nextRecord !== undefined) {
    byKey.set(getWorkflowStepKey(nextRecord), nextRecord);
  }
  return Array.from(byKey.values());
}

function hashSource(source: string): string {
  return `sha256:${crypto.createHash("sha256").update(source).digest("hex")}`;
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf-8");
}

async function appendJsonLines(filePath: string, values: readonly unknown[]): Promise<void> {
  if (values.length === 0) {
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(
    filePath,
    values.map((value) => JSON.stringify(value)).join("\n") + "\n",
    "utf-8"
  );
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function readJsonLines<T>(
  filePath: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }
): Promise<T[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const records: T[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (line.trim().length === 0) {
      continue;
    }

    try {
      const parsedJson = JSON.parse(line) as unknown;
      const parsedRecord = schema.safeParse(parsedJson);
      if (parsedRecord.success) {
        records.push(parsedRecord.data);
      } else {
        log.warn(`Skipping malformed workflow journal line ${index + 1} in ${filePath}`);
      }
    } catch (error) {
      log.warn(
        `Skipping malformed workflow journal line ${index + 1} in ${filePath}: ${getErrorMessage(error)}`
      );
    }
  }

  return records;
}

function getRunStatusFromEvents(
  events: readonly WorkflowRunEvent[]
): WorkflowRunStatus | undefined {
  return events.findLast((event) => event.type === "status")?.status;
}

function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return status === "completed" || status === "failed";
}

async function acquireWorkflowMutationLock(
  lockDir: string,
  staleLeaseMs: number,
  timeoutMs = staleLeaseMs
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await acquireLeaseMutationLock(lockDir, Date.now(), staleLeaseMs)) {
      return;
    }
    // Jittered backoff: a fixed sleep can phase-lock with the periodic lease renewal (whose
    // interval is also a small constant when staleLeaseMs is short, e.g. in tests), so every
    // retry lands while a renewal holds the lock and waiters starve for hundreds of ms.
    await new Promise((resolve) => setTimeout(resolve, 2 + Math.random() * 6));
  }
  throw new Error(`Timed out acquiring workflow mutation lock: ${lockDir}`);
}

async function acquireLeaseMutationLock(
  lockDir: string,
  nowMs: number,
  staleLeaseMs: number
): Promise<boolean> {
  try {
    await fs.mkdir(lockDir);
    return true;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw error;
    }
  }

  try {
    const stat = await fs.stat(lockDir);
    if (nowMs - stat.mtimeMs <= staleLeaseMs) {
      return false;
    }
    await fs.rm(lockDir, { recursive: true, force: true });
    await fs.mkdir(lockDir);
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST") || isErrno(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readLease(leaseFile: string): Promise<LeaseRecord | null> {
  try {
    const raw = JSON.parse(await fs.readFile(leaseFile, "utf-8")) as Partial<LeaseRecord>;
    if (typeof raw.ownerId === "string" && typeof raw.acquiredAtMs === "number") {
      return { ownerId: raw.ownerId, acquiredAtMs: raw.acquiredAtMs };
    }
  } catch {
    return null;
  }
  return null;
}
