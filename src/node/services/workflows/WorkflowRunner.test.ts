/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
import { describe, expect, test } from "bun:test";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import { DisposableTempDir } from "@/node/services/tempDir";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { WorkflowRunStore } from "./WorkflowRunStore";
import {
  WorkflowRunBackgroundedError,
  WorkflowRunner,
  type WorkflowTaskAdapter,
} from "./WorkflowRunner";
import { hashWorkflowStepInput } from "./workflowReplayKey";

const definition = {
  name: "deep-research",
  description: "Research a topic",
  scope: "built-in" as const,
  executable: true,
};

const source = `export default function workflow({ args, phase, log, agent }) {
  phase("scope", { topic: args.topic });
  log("delegating", { topic: args.topic });
  const summary = agent({ id: "summarize-topic", prompt: "Summarize " + args.topic });
  return { reportMarkdown: "Final: " + summary.reportMarkdown };
}
`;

async function createRunStore(sessionDir: string) {
  const store = new WorkflowRunStore({ sessionDir, staleLeaseMs: 10 });
  await store.createRun({
    id: "wfr_123",
    workspaceId: "workspace-1",
    definition,
    definitionSource: source,
    args: { topic: "durable workflows" },
    now: "2026-05-29T00:00:00.000Z",
  });
  return store;
}

function createRunner(store: WorkflowRunStore, taskAdapter: WorkflowTaskAdapter) {
  return new WorkflowRunner({
    runStore: store,
    runtimeFactory: new QuickJSRuntimeFactory(),
    taskAdapter,
    runnerId: "runner-a",
    clock: {
      nowIso: () => "2026-05-29T00:00:01.000Z",
      nowMs: () => 1_000,
    },
  });
}

describe("WorkflowRunner", () => {
  test("executes conductor primitives and persists run events/results", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const taskCalls: unknown[] = [];
    let runTimeoutMs: number | undefined;
    let runAbortSignalWasAbortedDuringAgent: boolean | undefined;
    const runner = createRunner(store, {
      async runAgent(spec, _lifecycle, waitOptions) {
        taskCalls.push(spec);
        runTimeoutMs = waitOptions?.timeoutMs;
        runAbortSignalWasAbortedDuringAgent = waitOptions?.abortSignal?.aborted;
        return {
          taskId: "task_1",
          reportMarkdown: "summary",
          structuredOutput: { sources: 3 },
        };
      },
    });

    const result = await runner.run("wfr_123");
    const run = await store.getRun("wfr_123");

    expect(result).toEqual({ reportMarkdown: "Final: summary" });
    expect(taskCalls).toEqual([{ id: "summarize-topic", prompt: "Summarize durable workflows" }]);
    expect(runTimeoutMs).toBeGreaterThan(5 * 60 * 1000);
    expect(runAbortSignalWasAbortedDuringAgent).toBe(false);
    expect(run.status).toBe("completed");
    expect(run.events.map((event) => event.type)).toEqual([
      "status",
      "phase",
      "log",
      "task",
      "task",
      "result",
      "status",
    ]);
    expect(run.events.filter((event) => event.type === "task")).toEqual([
      expect.objectContaining({ stepId: "summarize-topic", taskId: "task_1", status: "started" }),
      expect.objectContaining({ stepId: "summarize-topic", taskId: "task_1", status: "completed" }),
    ]);
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({
      stepId: "summarize-topic",
      status: "completed",
      taskId: "task_1",
      result: { reportMarkdown: "summary", structuredOutput: { sources: 3 } },
    });
  });

  test("records a started task event as soon as an agent task is created", async () => {
    using tmp = new DisposableTempDir("workflow-runner-started-task-event");
    const store = await createRunStore(tmp.path);
    const runner = createRunner(store, {
      async runAgent(_spec, lifecycle) {
        await lifecycle?.onTaskCreated?.("task_live");
        const runDuringTask = await store.getRun("wfr_123");
        expect(runDuringTask.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "task",
              stepId: "summarize-topic",
              taskId: "task_live",
              status: "started",
            }),
          ])
        );
        return {
          taskId: "task_live",
          reportMarkdown: "summary",
          structuredOutput: { sources: 3 },
        };
      },
    });

    await runner.run("wfr_123");
    const taskEvents = (await store.getRun("wfr_123")).events.filter(
      (event) => event.type === "task"
    );

    expect(taskEvents).toEqual([
      expect.objectContaining({
        stepId: "summarize-topic",
        taskId: "task_live",
        status: "started",
      }),
      expect.objectContaining({
        stepId: "summarize-topic",
        taskId: "task_live",
        status: "completed",
      }),
    ]);
  });

  test("returns child task IDs to workflow code", async () => {
    using tmp = new DisposableTempDir("workflow-runner-task-id");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_task_id",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow({ agent }) {
        const result = agent({ id: "implement", prompt: "Implement" });
        return { reportMarkdown: result.taskId };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        return { taskId: "task_impl", reportMarkdown: "implemented" };
      },
    });

    await expect(runner.run("wfr_task_id")).resolves.toEqual({ reportMarkdown: "task_impl" });
    const run = await store.getRun("wfr_task_id");

    expect(run.steps[0]?.result).toMatchObject({ taskId: "task_impl" });
  });

  test("applies workflow-owned child patches through a durable applyPatch step", async () => {
    using tmp = new DisposableTempDir("workflow-runner-apply-patch");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_apply_patch",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow({ agent, applyPatch }) {
        const implementation = agent({ id: "implement", prompt: "Implement" });
        const applied = applyPatch({ id: "apply-implement", source: implementation, target: "parent" });
        return { reportMarkdown: applied.status + ":" + applied.taskId };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const applyCalls: unknown[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        return { taskId: "task_impl", reportMarkdown: "implemented" };
      },
      async applyPatch(spec) {
        applyCalls.push(spec);
        return {
          success: true,
          taskId: spec.sourceTaskId,
          projectResults: [{ projectPath: "/repo", projectName: "repo", status: "applied" }],
        };
      },
    });

    await expect(runner.run("wfr_apply_patch")).resolves.toEqual({
      reportMarkdown: "applied:task_impl",
    });
    const run = await store.getRun("wfr_apply_patch");

    expect(applyCalls).toEqual([
      {
        id: "apply-implement",
        sourceTaskId: "task_impl",
        target: "parent",
        threeWay: true,
        force: false,
      },
    ]);
    expect(run.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: "apply-implement", status: "completed" }),
      ])
    );
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "patch", stepId: "apply-implement", status: "started" }),
        expect.objectContaining({ type: "patch", stepId: "apply-implement", status: "applied" }),
      ])
    );
  });

  test("replays completed applyPatch steps without reapplying", async () => {
    using tmp = new DisposableTempDir("workflow-runner-apply-patch-replay");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    const agentSpec = { id: "implement", prompt: "Implement" };
    const applySpec = {
      id: "apply-implement",
      sourceTaskId: "task_impl",
      target: "parent",
      threeWay: true,
      force: false,
    } as const;
    await store.createRun({
      id: "wfr_apply_patch_replay",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow({ agent, applyPatch }) {
        const implementation = agent({ id: "implement", prompt: "Implement" });
        const applied = applyPatch({ id: "apply-implement", source: implementation, target: "parent" });
        return { reportMarkdown: applied.status + ":" + applied.taskId };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await store.recordStepCompleted("wfr_apply_patch_replay", {
      stepId: agentSpec.id,
      inputHash: hashWorkflowStepInput(agentSpec.id, agentSpec),
      taskId: "task_impl",
      result: { taskId: "task_impl", reportMarkdown: "implemented" },
      startedAt: "2026-05-29T00:00:01.000Z",
      completedAt: "2026-05-29T00:00:02.000Z",
    });
    await store.recordStepCompleted("wfr_apply_patch_replay", {
      stepId: applySpec.id,
      inputHash: hashWorkflowStepInput(applySpec.id, applySpec),
      taskId: "task_impl",
      result: {
        reportMarkdown: "Patch applied from task task_impl.",
        structuredOutput: { success: true, status: "applied", taskId: "task_impl" },
      },
      startedAt: "2026-05-29T00:00:03.000Z",
      completedAt: "2026-05-29T00:00:04.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should replay");
      },
      async applyPatch() {
        throw new Error("patch should replay");
      },
    });

    await expect(runner.run("wfr_apply_patch_replay")).resolves.toEqual({
      reportMarkdown: "applied:task_impl",
    });
  });

  test("rejects applyPatch sources that are not workflow-owned child tasks", async () => {
    using tmp = new DisposableTempDir("workflow-runner-apply-patch-unowned");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_apply_patch_unowned",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow({ applyPatch }) {
        return applyPatch({ id: "apply-external", source: "task_external" });
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not run");
      },
      async applyPatch() {
        throw new Error("external task patch should not be applied");
      },
    });

    await expect(runner.run("wfr_apply_patch_unowned")).rejects.toThrow(
      /was not produced by a completed workflow agent step/
    );
  });

  test("marks run failed when runtime setup throws after starting", async () => {
    using tmp = new DisposableTempDir("workflow-runner-runtime-setup");
    const store = await createRunStore(tmp.path);
    const runner = new WorkflowRunner({
      runStore: store,
      runtimeFactory: {
        async create() {
          throw new Error("runtime unavailable");
        },
      },
      taskAdapter: {
        async runAgent() {
          throw new Error("should not spawn tasks");
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(runner.run("wfr_123")).rejects.toThrow("runtime unavailable");
    const run = await store.getRun("wfr_123");

    expect(run.status).toBe("failed");
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "error", message: "runtime unavailable" }),
        expect.objectContaining({ type: "status", status: "failed" }),
      ])
    );
  });

  test("requires explicit resume permission to restart interrupted runs", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    await store.appendStatus("wfr_123", "interrupted", "2026-05-29T00:00:00.500Z");
    let taskCalls = 0;
    const runner = createRunner(store, {
      async runAgent() {
        taskCalls += 1;
        return { taskId: "task_1", reportMarkdown: "summary" };
      },
    });

    await expect(runner.run("wfr_123")).rejects.toThrow(/interrupted/);
    await expect(store.getRun("wfr_123")).resolves.toMatchObject({ status: "interrupted" });
    expect(taskCalls).toBe(0);

    await expect(
      runner.run("wfr_123", { allowResumeFromInterrupted: true })
    ).resolves.toMatchObject({ reportMarkdown: "Final: summary" });
    await expect(store.getRun("wfr_123")).resolves.toMatchObject({ status: "completed" });
    expect(taskCalls).toBe(1);
  });

  test("aborts without terminal writes after losing its lease", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    let renewCalls = 0;
    let resolveTaskStarted!: () => void;
    const taskStarted = new Promise<void>((resolve) => {
      resolveTaskStarted = resolve;
    });
    store.renewLease = async () => {
      renewCalls += 1;
      if (renewCalls === 1) {
        return true;
      }
      await taskStarted;
      return false;
    };
    let sawAbort = false;
    const runner = createRunner(store, {
      async runAgent(_spec, _lifecycle, waitOptions) {
        resolveTaskStarted();
        return await new Promise<never>((_resolve, reject) => {
          const signal = waitOptions?.abortSignal;
          if (signal == null) {
            reject(new Error("missing abort signal"));
            return;
          }
          if (signal.aborted) {
            sawAbort = true;
            reject(new Error("task aborted"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(new Error("task aborted"));
            },
            { once: true }
          );
        });
      },
    });

    await expect(runner.run("wfr_123")).rejects.toThrow(/lease lost/);
    const run = await store.getRun("wfr_123");

    expect(renewCalls).toBeGreaterThan(0);
    expect(sawAbort).toBe(true);
    expect(run.status).toBe("running");
    expect(
      run.events.some((event) => event.type === "status" && event.status === "completed")
    ).toBe(false);
    expect(run.events.some((event) => event.type === "status" && event.status === "failed")).toBe(
      false
    );
  });

  test("replays completed agent steps without respawning child tasks", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    let taskCalls = 0;
    const runner = createRunner(store, {
      async runAgent() {
        taskCalls += 1;
        return { taskId: "task_1", reportMarkdown: "summary" };
      },
    });

    await runner.run("wfr_123");
    await runner.run("wfr_123");

    expect(taskCalls).toBe(1);
  });

  test("backfills completed task events when replaying completed agent steps", async () => {
    using tmp = new DisposableTempDir("workflow-runner-completed-task-event-backfill");
    const store = await createRunStore(tmp.path);
    const spec = { id: "summarize-topic", prompt: "Summarize durable workflows" };
    await store.recordStepCompleted("wfr_123", {
      stepId: spec.id,
      inputHash: hashWorkflowStepInput(spec.id, spec),
      taskId: "task_completed_missing_event",
      result: { taskId: "task_completed_missing_event", reportMarkdown: "summary" },
      startedAt: "2026-05-29T00:00:00.500Z",
      completedAt: "2026-05-29T00:00:00.750Z",
    });
    await store.appendEvent("wfr_123", {
      sequence: 1,
      type: "task",
      at: "2026-05-29T00:00:00.500Z",
      stepId: spec.id,
      taskId: "task_completed_missing_event",
      status: "started",
    });
    let taskCalls = 0;
    const runner = createRunner(store, {
      async runAgent() {
        taskCalls += 1;
        throw new Error("agent should replay");
      },
    });

    await expect(runner.run("wfr_123")).resolves.toEqual({ reportMarkdown: "Final: summary" });
    const taskEvents = (await store.getRun("wfr_123")).events.filter(
      (event) => event.type === "task" && event.taskId === "task_completed_missing_event"
    );

    expect(taskCalls).toBe(0);
    expect(taskEvents).toEqual([
      expect.objectContaining({ status: "started" }),
      expect.objectContaining({ status: "completed" }),
    ]);
  });

  test("reuses a recorded started task id instead of respawning on resume", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const spec = { id: "summarize-topic", prompt: "Summarize durable workflows" };
    await store.recordStepStarted("wfr_123", {
      stepId: spec.id,
      inputHash: hashWorkflowStepInput(spec.id, spec),
      taskId: "task_existing",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    await store.appendEvent("wfr_123", {
      sequence: 1,
      type: "task",
      at: "2026-05-29T00:00:00.500Z",
      stepId: spec.id,
      taskId: "task_existing",
      status: "started",
    });
    let runAgentCalls = 0;
    const waitedFor: string[] = [];
    let waitTimeoutMs: number | undefined;
    let waitAbortSignal: AbortSignal | undefined;
    const runner = createRunner(store, {
      async runAgent() {
        runAgentCalls += 1;
        return { taskId: "task_duplicate", reportMarkdown: "duplicate" };
      },
      async waitForAgentTask(taskId, _spec, waitOptions) {
        waitedFor.push(taskId);
        waitTimeoutMs = waitOptions?.timeoutMs;
        waitAbortSignal = waitOptions?.abortSignal;
        return { taskId, reportMarkdown: "summary" };
      },
    });

    await expect(runner.run("wfr_123")).resolves.toEqual({ reportMarkdown: "Final: summary" });

    expect(runAgentCalls).toBe(0);
    expect(waitedFor).toEqual(["task_existing"]);
    const startedEvents = (await store.getRun("wfr_123")).events.filter(
      (event) =>
        event.type === "task" && event.status === "started" && event.taskId === "task_existing"
    );
    expect(startedEvents).toHaveLength(1);
    expect(waitTimeoutMs).toBeGreaterThan(5 * 60 * 1000);
    expect(waitAbortSignal?.aborted).toBe(false);
  });

  test("adds one started task event when resuming legacy started steps", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-started-event");
    const store = await createRunStore(tmp.path);
    const spec = { id: "summarize-topic", prompt: "Summarize durable workflows" };
    await store.recordStepStarted("wfr_123", {
      stepId: spec.id,
      inputHash: hashWorkflowStepInput(spec.id, spec),
      taskId: "task_legacy",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not respawn");
      },
      async waitForAgentTask(taskId) {
        return { taskId, reportMarkdown: "summary" };
      },
    });

    await expect(runner.run("wfr_123")).resolves.toEqual({ reportMarkdown: "Final: summary" });
    const startedEvents = (await store.getRun("wfr_123")).events.filter(
      (event) =>
        event.type === "task" && event.status === "started" && event.taskId === "task_legacy"
    );

    expect(startedEvents).toHaveLength(1);
  });

  test("reruns stale started task ids that no longer have recoverable reports", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const spec = { id: "summarize-topic", prompt: "Summarize durable workflows" };
    await store.recordStepStarted("wfr_123", {
      stepId: spec.id,
      inputHash: hashWorkflowStepInput(spec.id, spec),
      taskId: "task_missing",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    let runAgentCalls = 0;
    const waitedFor: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        runAgentCalls += 1;
        return { taskId: "task_recovered", reportMarkdown: "summary" };
      },
      async waitForAgentTask(taskId) {
        waitedFor.push(taskId);
        throw new Error("Task not found");
      },
    });

    await expect(runner.run("wfr_123")).resolves.toEqual({ reportMarkdown: "Final: summary" });
    const run = await store.getRun("wfr_123");

    expect(waitedFor).toEqual(["task_missing"]);
    expect(runAgentCalls).toBe(1);
    expect(run.steps.at(-1)).toMatchObject({
      stepId: "summarize-topic",
      status: "completed",
      taskId: "task_recovered",
    });
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task",
          stepId: "summarize-topic",
          taskId: "task_missing",
          status: "failed",
        }),
        expect.objectContaining({
          type: "task",
          stepId: "summarize-topic",
          taskId: "task_recovered",
          status: "completed",
        }),
      ])
    );
  });

  test("records failed task events when an agent task fails after creation", async () => {
    using tmp = new DisposableTempDir("workflow-runner-child-failure");
    const store = await createRunStore(tmp.path);
    const runner = createRunner(store, {
      async runAgent(_spec, lifecycle) {
        await lifecycle?.onTaskCreated?.("task_failed_after_create");
        throw new Error("child execution failed");
      },
    });

    await expect(runner.run("wfr_123")).rejects.toThrow("child execution failed");
    const taskEvents = (await store.getRun("wfr_123")).events.filter(
      (event) => event.type === "task" && event.taskId === "task_failed_after_create"
    );

    expect(taskEvents).toEqual([
      expect.objectContaining({ status: "started" }),
      expect.objectContaining({ status: "failed" }),
    ]);
  });

  test("restarts started task records when resuming a user-interrupted run", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const spec = { id: "summarize-topic", prompt: "Summarize durable workflows" };
    await store.recordStepStarted("wfr_123", {
      stepId: spec.id,
      inputHash: hashWorkflowStepInput(spec.id, spec),
      taskId: "task_interrupted",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    await store.appendStatus("wfr_123", "interrupted", "2026-05-29T00:00:00.750Z");
    let runAgentCalls = 0;
    const waitedFor: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        runAgentCalls += 1;
        return { taskId: "task_restarted", reportMarkdown: "summary" };
      },
      async waitForAgentTask(taskId) {
        waitedFor.push(taskId);
        throw new Error("interrupted task should not be awaited");
      },
    });

    await expect(runner.run("wfr_123", { allowResumeFromInterrupted: true })).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });

    expect(runAgentCalls).toBe(1);
    expect(waitedFor).toEqual([]);
  });

  test("runs parallelAgents specs concurrently and returns ordered results", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_parallel",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow({ parallelAgents }) {
        const results = parallelAgents([
          { id: "source-a", prompt: "Read source A" },
          { id: "source-b", prompt: "Read source B" },
        ]);
        return { reportMarkdown: results.map((result) => result.reportMarkdown).join(" + ") };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const runner = createRunner(store, {
      async runAgent(spec, lifecycle) {
        calls.push(spec.id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await lifecycle?.onTaskCreated?.(`task_${spec.id}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { taskId: `task_${spec.id}`, reportMarkdown: spec.id };
      },
    });

    await expect(runner.run("wfr_parallel")).resolves.toEqual({
      reportMarkdown: "source-a + source-b",
    });

    expect(calls).toEqual(["source-a", "source-b"]);
    expect(maxActive).toBe(2);
    const run = await store.getRun("wfr_parallel");
    const eventSequences = run.events.map((event) => event.sequence);
    expect(eventSequences).toEqual([...eventSequences].sort((a, b) => a - b));
    expect(new Set(eventSequences).size).toBe(eventSequences.length);
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task",
          stepId: "source-a",
          taskId: "task_source-a",
          status: "started",
        }),
        expect.objectContaining({
          type: "task",
          stepId: "source-b",
          taskId: "task_source-b",
          status: "started",
        }),
      ])
    );
    expect(run.steps.map((step) => step.stepId).sort()).toEqual(["source-a", "source-b"]);
  });

  test("interrupts sibling parallelAgents when one child task fails", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_parallel_failure",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow({ parallelAgents }) {
        parallelAgents([
          { id: "source-a", prompt: "Read source A" },
          { id: "source-b", prompt: "Read source B" },
        ]);
        return { reportMarkdown: "unreachable" };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    let interruptRunCalls = 0;
    let releaseSourceB!: () => void;
    const sourceBInterrupted = new Promise<void>((resolve) => {
      releaseSourceB = resolve;
    });
    const calls: string[] = [];
    const runner = createRunner(store, {
      async runAgent(spec) {
        calls.push(spec.id);
        if (spec.id === "source-a") {
          throw new Error("source-a failed");
        }
        await sourceBInterrupted;
        throw new Error("source-b interrupted");
      },
      async interruptRun() {
        interruptRunCalls += 1;
        releaseSourceB();
      },
    });

    await expect(runner.run("wfr_parallel_failure")).rejects.toThrow("source-a failed");

    expect(calls).toEqual(["source-a", "source-b"]);
    expect(interruptRunCalls).toBe(1);
  });

  test("does not interrupt sibling parallelAgents when foreground wait backgrounds", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_parallel_backgrounded",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow({ parallelAgents }) {
        parallelAgents([
          { id: "source-a", prompt: "Read source A" },
          { id: "source-b", prompt: "Read source B" },
        ]);
        return { reportMarkdown: "unreachable" };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    let interruptRunCalls = 0;
    let sourceBStarted = false;
    const runner = createRunner(store, {
      async runAgent(spec, _lifecycle, waitOptions) {
        if (spec.id === "source-a") {
          throw new ForegroundWaitBackgroundedError();
        }
        sourceBStarted = true;
        await new Promise<never>((_resolve, reject) => {
          waitOptions?.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("Interrupted")),
            { once: true }
          );
        });
        throw new Error("unreachable");
      },
      async interruptRun() {
        interruptRunCalls += 1;
      },
    });

    await expect(runner.run("wfr_parallel_backgrounded")).rejects.toBeInstanceOf(
      WorkflowRunBackgroundedError
    );

    await expect(store.getRun("wfr_parallel_backgrounded")).resolves.toMatchObject({
      status: "backgrounded",
    });

    expect(sourceBStarted).toBe(true);
    expect(interruptRunCalls).toBe(0);
  });

  test("retries only failed parallelAgents steps after structured output validation errors", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_parallel_retry_validation",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow({ parallelAgents }) {
        const results = parallelAgents([
          {
            id: "source-a",
            prompt: "Summarize A",
            outputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
          },
          {
            id: "source-b",
            prompt: "Summarize B",
            outputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
          },
        ]);
        return { reportMarkdown: results.map((result) => result.structuredOutput.summary).join(" + ") };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const calls: string[] = [];
    const runner = createRunner(store, {
      async runAgent(spec) {
        calls.push(spec.id);
        if (spec.id === "source-b" && calls.filter((id) => id === "source-b").length === 1) {
          return { taskId: "task_source_b_bad", reportMarkdown: "bad" };
        }
        return {
          taskId: `task_${spec.id}_${calls.length}`,
          reportMarkdown: spec.id,
          structuredOutput: { summary: spec.id },
        };
      },
    });

    await expect(runner.run("wfr_parallel_retry_validation")).resolves.toEqual({
      reportMarkdown: "source-a + source-b",
    });
    const run = await store.getRun("wfr_parallel_retry_validation");

    expect(calls).toEqual(["source-a", "source-b", "source-b"]);
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task",
          stepId: "source-b",
          taskId: "task_source_b_bad",
          status: "failed",
        }),
        expect.objectContaining({
          type: "log",
          message: "Retrying source-b after validation failure",
        }),
      ])
    );
  });

  test("retries workflow agent steps that fail structured output validation", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_retry_validation",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow({ agent }) {
        const result = agent({
          id: "claims",
          prompt: "Extract claims",
          outputSchema: {
            type: "object",
            required: ["claims"],
            properties: { claims: { type: "array", items: { type: "string" } } },
            additionalProperties: false,
          },
        });
        return { reportMarkdown: result.structuredOutput.claims.join(", ") };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const prompts: string[] = [];
    const runner = createRunner(store, {
      async runAgent(spec) {
        prompts.push(spec.prompt);
        if (prompts.length === 1) {
          return { taskId: "task_bad", reportMarkdown: "bad" };
        }
        return {
          taskId: "task_good",
          reportMarkdown: "good",
          structuredOutput: { claims: ["durable"] },
        };
      },
    });

    await expect(runner.run("wfr_retry_validation")).resolves.toEqual({
      reportMarkdown: "durable",
    });
    const run = await store.getRun("wfr_retry_validation");

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Previous workflow attempt 1 failed output validation");
    expect(run.status).toBe("completed");
    expect(run.steps).toEqual([
      expect.objectContaining({ stepId: "claims", status: "completed", taskId: "task_good" }),
    ]);
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "validation", stepId: "claims", success: false }),
        expect.objectContaining({
          type: "task",
          stepId: "claims",
          taskId: "task_bad",
          status: "failed",
        }),
        expect.objectContaining({
          type: "task",
          stepId: "claims",
          taskId: "task_good",
          status: "completed",
        }),
        expect.objectContaining({
          type: "log",
          message: "Retrying claims after validation failure",
        }),
      ])
    );
  });

  test("stops retrying workflow agent validation after the maximum attempts", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_retry_exhausted",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow({ agent }) {
        return agent({
          id: "claims",
          prompt: "Extract claims",
          outputSchema: { type: "object", required: ["claims"], properties: { claims: { type: "array" } } },
        });
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    let calls = 0;
    const runner = createRunner(store, {
      async runAgent() {
        calls += 1;
        return { taskId: `task_bad_${calls}`, reportMarkdown: "bad" };
      },
    });

    await expect(runner.run("wfr_retry_exhausted")).rejects.toThrow(/structured output/);
    const run = await store.getRun("wfr_retry_exhausted");

    expect(calls).toBe(3);
    expect(run.status).toBe("failed");
    expect(run.steps).toEqual([
      expect.objectContaining({ stepId: "claims", status: "failed", taskId: "task_bad_3" }),
    ]);
    expect(
      run.events.filter(
        (event) => event.type === "task" && event.stepId === "claims" && event.status === "failed"
      )
    ).toHaveLength(3);
  });

  test("validates workflow agent structured output against requested schema", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_schema",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow({ agent }) {
        return agent({
          id: "claims",
          prompt: "Extract claims",
          outputSchema: {
            type: "object",
            required: ["claims"],
            properties: { claims: { type: "array", items: { type: "string" } } },
            additionalProperties: false,
          },
        });
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        return { taskId: "task_1", reportMarkdown: "bad", structuredOutput: { claims: [1] } };
      },
    });

    await expect(runner.run("wfr_schema")).rejects.toThrow(
      /structured output failed schema validation.*claims\[0\]/
    );
    const run = await store.getRun("wfr_schema");
    expect(run.steps).toEqual([
      expect.objectContaining({ stepId: "claims", status: "failed", taskId: "task_1" }),
    ]);
  });

  test("marks foreground-backgrounded agent waits as backgrounded runs", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const runner = createRunner(store, {
      async runAgent() {
        throw new ForegroundWaitBackgroundedError();
      },
    });

    await expect(runner.run("wfr_123")).rejects.toBeInstanceOf(WorkflowRunBackgroundedError);
    await expect(store.getRun("wfr_123")).resolves.toMatchObject({ status: "backgrounded" });
  });

  test("applies sandbox limits before evaluating workflow source", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_limits",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow() { return { reportMarkdown: "limited" }; }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    let limitsApplied = false;
    let evalSawLimits = false;
    let timeoutMs: number | undefined;
    const noop = () => undefined;
    const runner = new WorkflowRunner({
      runStore: store,
      runtimeFactory: {
        async create() {
          return {
            setLimits(limits) {
              limitsApplied = true;
              timeoutMs = limits.timeoutMs;
            },
            registerFunction: noop,
            registerObject: noop,
            onEvent: noop,
            abort: noop,
            getAbortSignal() {
              return undefined;
            },
            async eval() {
              evalSawLimits = limitsApplied;
              return {
                success: true,
                result: { reportMarkdown: "limited" },
                toolCalls: [],
                consoleOutput: [],
                duration_ms: 0,
              };
            },
            dispose: noop,
            [Symbol.dispose]: noop,
          };
        },
      },
      taskAdapter: {
        async runAgent() {
          throw new Error("agent should not run");
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(runner.run("wfr_limits")).resolves.toEqual({ reportMarkdown: "limited" });
    expect(timeoutMs).toBeGreaterThan(5 * 60 * 1000);
    expect(evalSawLimits).toBe(true);
  });

  test("supports async workflow function exports", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_async",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default async function workflow() { return { reportMarkdown: "async ok" }; }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not run");
      },
    });

    await expect(runner.run("wfr_async")).resolves.toEqual({ reportMarkdown: "async ok" });
  });

  test("returns the normalized workflow result for JSON-serializable values", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_normalized_return",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow() { return { summary: "done" }; }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not run");
      },
    });

    await expect(runner.run("wfr_normalized_return")).resolves.toEqual({
      reportMarkdown: JSON.stringify({ summary: "done" }),
    });
  });

  test("marks empty workflow returns as failed runs", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_empty_return",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow() {}`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not run");
      },
    });

    await expect(runner.run("wfr_empty_return")).rejects.toThrow(/must return/);
    const run = await store.getRun("wfr_empty_return");
    expect(run.status).toBe("failed");
    expect(run.events.some((event) => event.type === "result")).toBe(false);
  });

  test("does not overwrite an interrupted run with completed status", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    let releaseAgent!: () => void;
    let runPromise!: Promise<unknown>;
    const agentStarted = new Promise<void>((resolve) => {
      const runner = createRunner(store, {
        async runAgent() {
          resolve();
          await new Promise<void>((release) => {
            releaseAgent = release;
          });
          return { taskId: "task_1", reportMarkdown: "late summary" };
        },
      });
      runPromise = runner.run("wfr_123");
    });

    await agentStarted;
    await store.appendStatus("wfr_123", "interrupted", "2026-05-29T00:00:02.000Z");
    releaseAgent();
    await expect(runPromise).rejects.toThrow(/interrupted/);

    const run = await store.getRun("wfr_123");
    expect(run.status).toBe("interrupted");
    expect(run.events.some((event) => event.type === "result")).toBe(false);
  });

  test("marks compile failures as failed runs", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_compile_error",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default () => ({ reportMarkdown: "bad shape" });`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not run");
      },
    });

    await expect(runner.run("wfr_compile_error")).rejects.toThrow(/export a default function/);
    const run = await store.getRun("wfr_compile_error");
    expect(run.status).toBe("failed");
    expect(run.events.map((event) => event.type)).toContain("error");
  });

  test("fails fast when a replay-boundary primitive omits a stable id", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_missing_id",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow({ agent }) { return agent({ prompt: "no id" }); }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not run without a stable id");
      },
    });

    await expect(runner.run("wfr_missing_id")).rejects.toThrow(/stable id/);
  });

  test("does not expose mux tools, filesystem imports, or timers to workflow code", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await store.createRun({
      id: "wfr_forbidden",
      workspaceId: "workspace-1",
      definition,
      definitionSource: `export default function workflow() {
        return {
          mux: typeof mux,
          require: typeof require,
          setTimeout: typeof setTimeout,
          Date: typeof Date,
          random: typeof Math.random,
        };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not run");
      },
    });

    const result = await runner.run("wfr_forbidden");

    expect(JSON.parse(result.reportMarkdown)).toEqual({
      mux: "undefined",
      require: "undefined",
      setTimeout: "undefined",
      Date: "undefined",
      random: "undefined",
    });
  });
});
