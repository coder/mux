/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
import { describe, expect, mock, test } from "bun:test";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import { DisposableTempDir } from "@/node/services/tempDir";
import { WorkflowRunStore } from "./WorkflowRunStore";
import {
  WorkflowRunBackgroundedError,
  WorkflowRunner,
  type WorkflowAgentSpec,
  type WorkflowTaskAdapter,
} from "./WorkflowRunner";
import { hashWorkflowStepInput } from "./workflowReplayKey";

const WORKFLOW_RUNNER_TEST_STALE_LEASE_MS = 100;

const definition = {
  name: "deep-research",
  description: "Research a topic",
  scope: "built-in" as const,
  executable: true,
};

const source = `export default function workflow({ args, phase, log, agent }) {
  phase("scope", { topic: args.topic });
  log("delegating", { topic: args.topic });
  const summary = agent("Summarize " + args.topic, { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`;

async function createRunStore(sessionDir: string) {
  const store = new WorkflowRunStore({
    sessionDir,
    staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
  });
  await store.createRun({
    id: "wfr_123",
    workspaceId: "workspace-1",
    workflow: definition,
    source: source,
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

function createDeferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("WorkflowRunner", () => {
  test("runs onRunEnded after a successful workflow", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const lifecycle: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        lifecycle.push("agent");
        return { taskId: "task_1", reportMarkdown: "summary", structuredOutput: {} };
      },
      onRunEnded() {
        lifecycle.push("ended");
      },
    });

    await runner.run("wfr_123");

    expect(lifecycle).toEqual(["agent", "ended"]);
  });

  test("new agent API returns structured output for schema-backed steps and markdown otherwise", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-api");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_agent_api",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const structured = agent("Return structured output", {
    id: "structured",
    schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
  });
  const markdown = agent("Return markdown output", { id: "markdown" });
  return { reportMarkdown: structured.answer + " / " + markdown };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const seenSpecs: WorkflowAgentSpec[] = [];
    const runner = createRunner(store, {
      async runAgent(spec) {
        seenSpecs.push(spec);
        if (spec.id === "structured") {
          return {
            taskId: "task_structured",
            reportMarkdown: "unused markdown",
            structuredOutput: { answer: "structured answer" },
          };
        }
        return { taskId: "task_markdown", reportMarkdown: "markdown answer", structuredOutput: {} };
      },
    });

    const result = await runner.run("wfr_agent_api");

    expect(result).toEqual({ reportMarkdown: "structured answer / markdown answer" });
    expect(seenSpecs).toHaveLength(2);
    expect(seenSpecs[0]).toMatchObject({ id: "structured" });
    expect(seenSpecs[0]?.outputSchema).toEqual({
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    });
    expect(seenSpecs[1]).toMatchObject({ id: "markdown" });
  });

  test("parallel runs agent thunks concurrently and returns ordered schema outputs", async () => {
    using tmp = new DisposableTempDir("workflow-runner-parallel-api");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_parallel_api",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ parallel, agent }) {
  const results = parallel([
    () => agent("First", { id: "first", schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }),
    () => agent("Second", { id: "second", schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }),
  ]);
  return { reportMarkdown: results.map((result) => result.value).join(",") };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const firstTaskCreated = createDeferred();
    const secondTaskCreated = createDeferred();
    const releaseReports = createDeferred();
    const starts: string[] = [];
    const runner = createRunner(store, {
      async runAgent(spec, lifecycle) {
        starts.push(spec.id);
        await lifecycle?.onTaskCreated?.(`task_${spec.id}`);
        if (spec.id === "first") firstTaskCreated.resolve();
        if (spec.id === "second") secondTaskCreated.resolve();
        await releaseReports.promise;
        return {
          taskId: `task_${spec.id}`,
          reportMarkdown: spec.id,
          structuredOutput: { value: spec.id },
        };
      },
    });

    const runPromise = runner.run("wfr_parallel_api");
    await Promise.all([firstTaskCreated.promise, secondTaskCreated.promise]);
    expect(starts).toEqual(["first", "second"]);
    releaseReports.resolve();

    await expect(runPromise).resolves.toEqual({ reportMarkdown: "first,second" });
  });

  test("parallel thunks start agent tasks before waiting and preserve input order", async () => {
    using tmp = new DisposableTempDir("workflow-runner-parallel-thunks");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_parallel_thunks",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent, parallel }) {
  const schema = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
  const results = parallel([
    () => agent("Read source A", { id: "source-a", schema }),
    () => agent("Read source B", { id: "source-b", schema }),
  ]);
  return { reportMarkdown: results.map((result) => result.label).join(" + ") };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const trace: string[] = [];
    const createAgentTasks = mock(
      async (
        specs: WorkflowAgentSpec[],
        lifecycle?: { onTaskCreated?: (index: number, taskId: string) => Promise<void> | void }
      ) => {
        for (const [index, spec] of specs.entries()) {
          trace.push(`create:${spec.id}`);
          await lifecycle?.onTaskCreated?.(index, `task_${spec.id}`);
        }
        return specs.map((spec) => ({ taskId: `task_${spec.id}`, status: "starting" as const }));
      }
    );
    const waitForAgentTask = mock(async (taskId: string) => {
      trace.push(`wait:${taskId}`);
      if (taskId === "task_source-a") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const label = taskId.replace("task_", "");
      return { taskId, reportMarkdown: label, structuredOutput: { label } };
    });
    const runAgent = mock(async () => {
      throw new Error("parallel should use captured specs instead of running thunks serially");
    });
    const runner = createRunner(store, { runAgent, createAgentTasks, waitForAgentTask });

    await expect(runner.run("wfr_parallel_thunks")).resolves.toEqual({
      reportMarkdown: "source-a + source-b",
    });

    expect(createAgentTasks).toHaveBeenCalledTimes(1);
    expect(runAgent).not.toHaveBeenCalled();
    expect(waitForAgentTask).toHaveBeenCalledTimes(2);
    expect(trace.slice(0, 2)).toEqual(["create:source-a", "create:source-b"]);
    expect(trace).toEqual(expect.arrayContaining(["wait:task_source-a", "wait:task_source-b"]));
  });

  test("pipeline advances items to later stages without waiting for a full-stage barrier", async () => {
    using tmp = new DisposableTempDir("workflow-runner-pipeline-nonbarrier");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_pipeline_nonbarrier",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent, pipeline }) {
  const schema = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
  const results = pipeline(
    ["a", "b"],
    (item) => agent("Stage 1 " + item, { id: "stage1-" + item, schema }),
    (stage1) => agent("Stage 2 " + stage1.label, { id: "stage2-" + stage1.label, schema })
  );
  return { reportMarkdown: results.map((result) => result.label).join(",") };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const releaseStage1B = createDeferred();
    const trace: string[] = [];
    const createAgentTasks = mock(
      async (
        specs: WorkflowAgentSpec[],
        lifecycle?: { onTaskCreated?: (index: number, taskId: string) => Promise<void> | void }
      ) => {
        for (const [index, spec] of specs.entries()) {
          trace.push(`create:${spec.id}`);
          await lifecycle?.onTaskCreated?.(index, `task_${spec.id}`);
          if (spec.id === "stage2-a") {
            releaseStage1B.resolve();
          }
        }
        return specs.map((spec) => ({ taskId: `task_${spec.id}`, status: "starting" as const }));
      }
    );
    const waitForAgentTask = mock(async (taskId: string) => {
      trace.push(`wait-start:${taskId}`);
      if (taskId === "task_stage1-b") {
        await releaseStage1B.promise;
      }
      trace.push(`wait-done:${taskId}`);
      const label = taskId.startsWith("task_stage1-")
        ? taskId.replace("task_stage1-", "")
        : `done-${taskId.replace("task_stage2-", "")}`;
      return { taskId, reportMarkdown: label, structuredOutput: { label } };
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("pipeline should start agent tasks without using runAgent");
      },
      createAgentTasks,
      waitForAgentTask,
    });

    await expect(runner.run("wfr_pipeline_nonbarrier")).resolves.toEqual({
      reportMarkdown: "done-a,done-b",
    });
    expect(trace.indexOf("create:stage2-a")).toBeGreaterThan(-1);
    expect(trace.indexOf("wait-done:task_stage1-b")).toBeGreaterThan(-1);
    expect(trace.indexOf("create:stage2-a")).toBeLessThan(trace.indexOf("wait-done:task_stage1-b"));
  });

  test("pipeline interrupts sibling agents when one wait fails", async () => {
    using tmp = new DisposableTempDir("workflow-runner-pipeline-failure-interrupt");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_pipeline_failure_interrupt",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent, pipeline }) {
  const schema = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
  return pipeline(["slow", "fail"], (item) => agent("Stage " + item, { id: item, schema }));
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const releaseSlowTask = createDeferred();
    const createAgentTasks = mock(
      async (
        specs: WorkflowAgentSpec[],
        lifecycle?: { onTaskCreated?: (index: number, taskId: string) => Promise<void> | void }
      ) => {
        for (const [index, spec] of specs.entries()) {
          await lifecycle?.onTaskCreated?.(index, `task_${spec.id}`);
        }
        return specs.map((spec) => ({ taskId: `task_${spec.id}`, status: "starting" as const }));
      }
    );
    const waitForAgentTask = mock(async (taskId: string) => {
      if (taskId === "task_fail") {
        throw new Error("pipeline child failed");
      }
      await releaseSlowTask.promise;
      return { taskId, reportMarkdown: "slow", structuredOutput: { label: "slow" } };
    });
    const interruptRun = mock(async () => {
      releaseSlowTask.resolve();
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("pipeline should start agent tasks without using runAgent");
      },
      createAgentTasks,
      waitForAgentTask,
      interruptRun,
    });

    await expect(runner.run("wfr_pipeline_failure_interrupt")).rejects.toThrow(
      "pipeline child failed"
    );
    expect(interruptRun).toHaveBeenCalledTimes(1);
  });

  test("pipeline interrupts sibling agents when result validation fails", async () => {
    using tmp = new DisposableTempDir("workflow-runner-pipeline-validation-interrupt");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_pipeline_validation_interrupt",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent, pipeline }) {
  const schema = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
  return pipeline(["slow", "invalid"], (item) => agent("Stage " + item, { id: item, schema }));
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const releaseSlowTask = createDeferred();
    const createAgentTasks = mock(
      async (
        specs: WorkflowAgentSpec[],
        lifecycle?: { onTaskCreated?: (index: number, taskId: string) => Promise<void> | void }
      ) => {
        for (const [index, spec] of specs.entries()) {
          await lifecycle?.onTaskCreated?.(index, `task_${spec.id}`);
        }
        return specs.map((spec) => ({ taskId: `task_${spec.id}`, status: "starting" as const }));
      }
    );
    const waitForAgentTask = mock(async (taskId: string) => {
      if (taskId === "task_invalid") {
        return { taskId, reportMarkdown: "invalid", structuredOutput: {} };
      }
      await releaseSlowTask.promise;
      return { taskId, reportMarkdown: "slow", structuredOutput: { label: "slow" } };
    });
    const interruptRun = mock(async () => {
      releaseSlowTask.resolve();
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("pipeline should start agent tasks without using runAgent");
      },
      createAgentTasks,
      waitForAgentTask,
      interruptRun,
    });

    await expect(runner.run("wfr_pipeline_validation_interrupt")).rejects.toThrow(
      "structured output failed schema validation"
    );
    expect(interruptRun).toHaveBeenCalledTimes(1);
  });

  test("workflow primitive requires a stable id before creating child runs", async () => {
    using tmp = new DisposableTempDir("workflow-runner-nested-workflow-missing-id");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_nested_missing_id",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ workflow }) {
  return workflow({ script_path: "./child.js", args: {} });
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("workflow primitive should not spawn agent tasks");
      },
    });

    await expect(runner.run("wfr_nested_missing_id")).rejects.toThrow(
      "workflow replay boundary requires a stable id"
    );
  });

  test("workflow primitive accepts script path shorthand", async () => {
    using tmp = new DisposableTempDir("workflow-runner-nested-workflow-shorthand");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_nested_shorthand",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ workflow }) {
  const child = workflow("./child.js", { id: "child", args: { topic: "shorthand" } });
  return { reportMarkdown: child.reportMarkdown };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const seenSpecs: Array<{ scriptPath: string; args: unknown }> = [];
    const createRun = mock(async (input: { spec: { scriptPath: string; args: unknown } }) => {
      seenSpecs.push({ scriptPath: input.spec.scriptPath, args: input.spec.args });
      return { runId: "wfr_child_shorthand", name: "child" };
    });
    const runChild = mock(async () => ({ reportMarkdown: "child-result" }));
    const runner = new WorkflowRunner({
      runStore: store,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("workflow primitive should not spawn agent tasks");
        },
      },
      nestedWorkflowAdapter: { createRun, run: runChild },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(runner.run("wfr_nested_shorthand")).resolves.toEqual({
      reportMarkdown: "child-result",
    });
    expect(seenSpecs).toEqual([{ scriptPath: "./child.js", args: { topic: "shorthand" } }]);
  });

  test("workflow primitive replays a completed child step with the same script path and args", async () => {
    using tmp = new DisposableTempDir("workflow-runner-nested-workflow-replay");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_nested_replay",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ workflow }) {
  const first = workflow({ id: "child", script_path: "./child.js", args: { topic: "same" } });
  const second = workflow({ id: "child", script_path: "./child.js", args: { topic: "same" } });
  return { reportMarkdown: first.reportMarkdown + ":" + second.reportMarkdown };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const createRun = mock(async () => ({ runId: "wfr_child_replay", name: "child" }));
    const runChild = mock(async () => ({ reportMarkdown: "child-result" }));
    const runner = new WorkflowRunner({
      runStore: store,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("workflow primitive should not spawn agent tasks");
        },
      },
      nestedWorkflowAdapter: { createRun, run: runChild },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(runner.run("wfr_nested_replay")).resolves.toEqual({
      reportMarkdown: "child-result:child-result",
    });
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(runChild).toHaveBeenCalledTimes(1);
  });

  test("workflow primitive treats changed args as a distinct child replay identity", async () => {
    using tmp = new DisposableTempDir("workflow-runner-nested-workflow-input-hash");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_nested_changed_args",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ workflow }) {
  const first = workflow({ id: "child", script_path: "./child.js", args: { topic: "a" } });
  const second = workflow({ id: "child", script_path: "./child.js", args: { topic: "b" } });
  return { reportMarkdown: first.reportMarkdown + ":" + second.reportMarkdown };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const inputHashes: string[] = [];
    const createRun = mock(async (input: { inputHash: string }) => {
      inputHashes.push(input.inputHash);
      return { runId: `wfr_child_changed_args_${inputHashes.length}`, name: "child" };
    });
    const runChild = mock(async (runId: string) => ({ reportMarkdown: runId }));
    const runner = new WorkflowRunner({
      runStore: store,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("workflow primitive should not spawn agent tasks");
        },
      },
      nestedWorkflowAdapter: { createRun, run: runChild },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(runner.run("wfr_nested_changed_args")).resolves.toEqual({
      reportMarkdown: "wfr_child_changed_args_1:wfr_child_changed_args_2",
    });
    expect(inputHashes).toHaveLength(2);
    expect(new Set(inputHashes).size).toBe(2);
    expect(runChild).toHaveBeenCalledTimes(2);
  });

  test("workflow primitive treats changed script paths as distinct child replay identities", async () => {
    using tmp = new DisposableTempDir("workflow-runner-nested-workflow-script-path-hash");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_nested_changed_script_path",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ workflow }) {
  const first = workflow({ id: "child", script_path: "./child-a.js", args: { topic: "same" } });
  const second = workflow({ id: "child", script_path: "./child-b.js", args: { topic: "same" } });
  return { reportMarkdown: first.reportMarkdown + ":" + second.reportMarkdown };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const inputHashes: string[] = [];
    const scriptPaths: string[] = [];
    const createRun = mock(async (input: { inputHash: string; spec: { scriptPath: string } }) => {
      inputHashes.push(input.inputHash);
      scriptPaths.push(input.spec.scriptPath);
      return { runId: `wfr_child_changed_script_${inputHashes.length}`, name: "child" };
    });
    const runChild = mock(async (runId: string) => ({ reportMarkdown: runId }));
    const runner = new WorkflowRunner({
      runStore: store,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("workflow primitive should not spawn agent tasks");
        },
      },
      nestedWorkflowAdapter: { createRun, run: runChild },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(runner.run("wfr_nested_changed_script_path")).resolves.toEqual({
      reportMarkdown: "wfr_child_changed_script_1:wfr_child_changed_script_2",
    });
    expect(scriptPaths).toEqual(["./child-a.js", "./child-b.js"]);
    expect(inputHashes).toHaveLength(2);
    expect(new Set(inputHashes).size).toBe(2);
    expect(runChild).toHaveBeenCalledTimes(2);
  });

  test("fails before spawning when workflow code uses the removed object-form agent API", async () => {
    using tmp = new DisposableTempDir("workflow-runner-object-form-agent");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_object_form_agent",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  return agent({ id: "old-shape", prompt: "Old object shape" });
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runAgent = mock(async () => ({
      taskId: "task_1",
      reportMarkdown: "summary",
      structuredOutput: {},
    }));
    const runner = createRunner(store, { runAgent });

    await expect(runner.run("wfr_object_form_agent")).rejects.toThrow(
      "agent requires a non-empty prompt"
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  test("fails before spawning when workflow agent outputSchema is invalid", async () => {
    using tmp = new DisposableTempDir("workflow-runner-invalid-output-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_invalid_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  return agent("Invalid schema", { id: "invalid-schema", schema: { type: "definitely-not-json-schema" } });
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runAgent = mock(async () => ({
      taskId: "task_1",
      reportMarkdown: "summary",
      structuredOutput: {},
    }));
    const runner = createRunner(store, { runAgent });

    await expect(runner.run("wfr_invalid_schema")).rejects.toThrow(
      "Workflow agent step invalid-schema has invalid outputSchema"
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  test("fails before spawning when workflow agent outputSchema is not an object schema", async () => {
    using tmp = new DisposableTempDir("workflow-runner-scalar-output-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_scalar_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  return agent("Return a scalar", { id: "scalar", schema: { type: "string" } });
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runAgent = mock(async () => ({
      taskId: "task_1",
      reportMarkdown: "summary",
      structuredOutput: "scalar",
    }));
    const runner = createRunner(store, { runAgent });

    await expect(runner.run("wfr_scalar_schema")).rejects.toThrow(
      "Workflow agent schemas must be object schemas"
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  test("runs the terminal lifecycle callback when the workflow fails", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const lifecycle: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent exploded");
      },
      onRunEnded() {
        lifecycle.push("ended");
      },
    });

    await expect(runner.run("wfr_123")).rejects.toThrow("agent exploded");

    expect(lifecycle).toEqual(["ended"]);
  });

  test("does not run the terminal lifecycle callback when the lease belongs to another runner", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    // Simulate a concurrent runner owning a fresh (non-stale) lease at the
    // same clock instant the runner under test will see (nowMs = 1000).
    expect(await store.acquireLease("wfr_123", "runner-other", 1_000)).toBe(true);

    const lifecycle: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        return { taskId: "task_1", reportMarkdown: "summary", structuredOutput: {} };
      },
      onRunEnded() {
        lifecycle.push("ended");
      },
    });

    await expect(runner.run("wfr_123")).rejects.toThrow("Workflow run is already active");

    // The lease owner is responsible for the terminal lifecycle callback; this runner must not.
    expect(lifecycle).toEqual([]);
  });

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
    expect(taskCalls).toEqual([
      { id: "summarize-topic", prompt: "Summarize durable workflows", markdownOnly: true },
    ]);
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

  test("task events carry the agent spec title and omit it when the spec has none", async () => {
    using tmp = new DisposableTempDir("workflow-runner-task-event-title");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_titled",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
        agent("Verify", {
          id: "verify-claim-0-vote-2",
          title: "Verify claim 1 vote 3",
          schema: { type: "object", additionalProperties: false },
        });
        agent("No title", {
          id: "untitled-step",
          schema: { type: "object", additionalProperties: false },
        });
        return { reportMarkdown: "done" };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    let nextTaskNumber = 1;
    const runner = createRunner(store, {
      async runAgent(_spec, lifecycle) {
        const taskId = `task_${nextTaskNumber}`;
        nextTaskNumber += 1;
        // Report the taskId via the lifecycle callback like the production adapter
        // does, so the started-event title is pinned on the lifecycle path rather
        // than the post-hoc fallback.
        await lifecycle?.onTaskCreated?.(taskId);
        return { taskId, reportMarkdown: "ok", structuredOutput: {} };
      },
    });

    await runner.run("wfr_titled");
    const taskEvents = (await store.getRun("wfr_titled")).events.filter(
      (event) => event.type === "task"
    );

    expect(taskEvents).toEqual([
      expect.objectContaining({
        stepId: "verify-claim-0-vote-2",
        title: "Verify claim 1 vote 3",
        status: "started",
      }),
      expect.objectContaining({
        stepId: "verify-claim-0-vote-2",
        title: "Verify claim 1 vote 3",
        status: "completed",
      }),
      expect.objectContaining({ stepId: "untitled-step", status: "started" }),
      expect.objectContaining({ stepId: "untitled-step", status: "completed" }),
    ]);
    // Untitled specs must omit the field rather than defaulting it to something else.
    const untitledEvents = taskEvents.filter((event) => event.stepId === "untitled-step");
    expect(untitledEvents).toHaveLength(2);
    for (const event of untitledEvents) {
      expect(event.title).toBeUndefined();
    }
  });

  test("returns markdown-only agent reports as text to workflow code", async () => {
    using tmp = new DisposableTempDir("workflow-runner-markdown-agent-result");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_markdown_agent_result",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
        const result = agent("Implement", { id: "implement" });
        return { reportMarkdown: result };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        return { taskId: "task_impl", reportMarkdown: "implemented" };
      },
    });

    await expect(runner.run("wfr_markdown_agent_result")).resolves.toEqual({
      reportMarkdown: "implemented",
    });
    const run = await store.getRun("wfr_markdown_agent_result");

    expect(run.steps[0]?.result).toMatchObject({ taskId: "task_impl" });
  });

  test("applyPatch applies a completed workflow agent patch by agentId", async () => {
    using tmp = new DisposableTempDir("workflow-runner-apply-patch-agent-id");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_apply_patch_agent_id",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent, applyPatch }) {
  agent("Implement the change", { id: "implement", agentType: "exec" });
  const patch = applyPatch({ id: "apply-implement", agentId: "implement" });
  return { reportMarkdown: patch.status + ":" + patch.taskId };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const applyPatchCalls: unknown[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        return { taskId: "task_impl", reportMarkdown: "implemented", structuredOutput: {} };
      },
      async applyPatch(spec) {
        applyPatchCalls.push(spec);
        return {
          success: true,
          status: "applied",
          taskId: spec.sourceTaskId,
          appliedCommits: ["abc123"],
        };
      },
    });

    await expect(runner.run("wfr_apply_patch_agent_id")).resolves.toEqual({
      reportMarkdown: "applied:task_impl",
    });
    const run = await store.getRun("wfr_apply_patch_agent_id");

    expect(applyPatchCalls).toHaveLength(1);
    expect(applyPatchCalls[0]).toMatchObject({
      id: "apply-implement",
      sourceTaskId: "task_impl",
      target: "parent",
    });
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "patch",
          stepId: "apply-implement",
          sourceTaskId: "task_impl",
          status: "applied",
        }),
      ])
    );
  });

  test("applyPatch fails before adapter calls when agentId has not completed", async () => {
    using tmp = new DisposableTempDir("workflow-runner-apply-patch-missing-agent-id");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_apply_patch_missing_agent_id",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ applyPatch }) {
  return applyPatch({ id: "apply-missing", agentId: "missing" });
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const applyPatch = mock(async () => {
      throw new Error("applyPatch adapter should not be called");
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("No agent steps expected");
      },
      applyPatch,
    });

    await expect(runner.run("wfr_apply_patch_missing_agent_id")).rejects.toThrow(
      "applyPatch agentId missing was not produced by a completed workflow agent step"
    );
    expect(applyPatch).not.toHaveBeenCalled();
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
        return { taskId: "task_1", reportMarkdown: "summary", structuredOutput: {} };
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

  test("requires explicit checkpoint retry permission to restart failed runs", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const spec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepStarted("wfr_123", {
      stepId: spec.id,
      inputHash: hashWorkflowStepInput(spec.id, spec),
      taskId: "task_existing",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    await store.appendEvent("wfr_123", {
      sequence: 1,
      type: "error",
      at: "2026-05-29T00:00:00.750Z",
      message: "Execution interrupted",
    });
    await store.appendStatus("wfr_123", "failed", "2026-05-29T00:00:00.751Z");

    let runAgentCalls = 0;
    const waitedFor: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        runAgentCalls += 1;
        return { taskId: "task_duplicate", reportMarkdown: "duplicate", structuredOutput: {} };
      },
      async waitForAgentTask(taskId) {
        waitedFor.push(taskId);
        return { taskId, reportMarkdown: "summary", structuredOutput: {} };
      },
    });

    await expect(runner.run("wfr_123")).rejects.toThrow(/failed/);
    await expect(runner.run("wfr_123", { allowRetryFromFailedCheckpoint: true })).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
    const run = await store.getRun("wfr_123");

    expect(run.status).toBe("completed");
    expect(waitedFor).toEqual(["task_existing"]);
    expect(runAgentCalls).toBe(0);
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
        return { taskId: "task_1", reportMarkdown: "summary", structuredOutput: {} };
      },
    });

    await runner.run("wfr_123");
    await runner.run("wfr_123");

    expect(taskCalls).toBe(1);
  });

  test("replays completed legacy agent steps that omitted outputSchema", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-completed-missing-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_completed_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    const legacySpec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepCompleted("wfr_legacy_completed_schema", {
      stepId: legacySpec.id,
      inputHash: hashWorkflowStepInput(legacySpec.id, legacySpec),
      taskId: "task_legacy_completed",
      result: { taskId: "task_legacy_completed", reportMarkdown: "summary", structuredOutput: {} },
      startedAt: "2026-05-29T00:00:00.500Z",
      completedAt: "2026-05-29T00:00:00.750Z",
    });
    const runAgent = mock(async () => {
      throw new Error("agent should replay");
    });
    const runner = createRunner(store, { runAgent });

    await expect(runner.run("wfr_legacy_completed_schema")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  test("replays completed legacy agent steps before validating old outputSchema keywords", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-completed-invalid-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_completed_invalid_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    const legacySpec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepCompleted("wfr_legacy_completed_invalid_schema", {
      stepId: legacySpec.id,
      inputHash: hashWorkflowStepInput(legacySpec.id, legacySpec),
      taskId: "task_legacy_completed",
      result: { taskId: "task_legacy_completed", reportMarkdown: "summary" },
      startedAt: "2026-05-29T00:00:00.500Z",
      completedAt: "2026-05-29T00:00:00.750Z",
    });
    const runAgent = mock(async () => {
      throw new Error("agent should replay");
    });
    const runner = createRunner(store, { runAgent });

    await expect(runner.run("wfr_legacy_completed_invalid_schema")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  test("resumes started legacy agent steps before validating old outputSchema keywords", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-started-invalid-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_started_invalid_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    await store.appendStatus(
      "wfr_legacy_started_invalid_schema",
      "running",
      "2026-05-29T00:00:00.250Z"
    );
    const legacySpec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepStarted("wfr_legacy_started_invalid_schema", {
      stepId: legacySpec.id,
      inputHash: hashWorkflowStepInput(legacySpec.id, legacySpec),
      taskId: "task_legacy_started",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    const runAgent = mock(async () => {
      throw new Error("agent should resume existing task");
    });
    const waitedFor: string[] = [];
    const runner = createRunner(store, {
      runAgent,
      async waitForAgentTask(taskId) {
        waitedFor.push(taskId);
        return { taskId, reportMarkdown: "summary" };
      },
    });

    await expect(runner.run("wfr_legacy_started_invalid_schema")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
    expect(runAgent).not.toHaveBeenCalled();
    expect(waitedFor).toEqual(["task_legacy_started"]);
  });

  test("resumes started legacy agent steps that omitted outputSchema", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-started-missing-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_started_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    await store.appendStatus("wfr_legacy_started_schema", "running", "2026-05-29T00:00:00.250Z");
    const legacySpec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepStarted("wfr_legacy_started_schema", {
      stepId: legacySpec.id,
      inputHash: hashWorkflowStepInput(legacySpec.id, legacySpec),
      taskId: "task_legacy_started",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    const runAgent = mock(async () => {
      throw new Error("agent should resume existing task");
    });
    const waitedFor: string[] = [];
    const runner = createRunner(store, {
      runAgent,
      async waitForAgentTask(taskId) {
        waitedFor.push(taskId);
        return { taskId, reportMarkdown: "summary" };
      },
    });

    await expect(runner.run("wfr_legacy_started_schema")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
    expect(runAgent).not.toHaveBeenCalled();
    expect(waitedFor).toEqual(["task_legacy_started"]);
  });

  test("runs unstarted legacy markdown-only workflow steps without outputSchema", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-unstarted-invalid-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_unstarted_invalid_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    await store.appendStatus(
      "wfr_legacy_unstarted_invalid_schema",
      "running",
      "2026-05-29T00:00:00.250Z"
    );
    const runner = createRunner(store, {
      async runAgent(spec) {
        expect(spec.outputSchema).toBeUndefined();
        return { taskId: "task_legacy_unstarted", reportMarkdown: "summary" };
      },
    });

    await expect(runner.run("wfr_legacy_unstarted_invalid_schema")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
  });

  test("does not synthesize outputSchema for markdown-only legacy workflow steps", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-unstarted-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_unstarted_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    await store.appendStatus("wfr_legacy_unstarted_schema", "running", "2026-05-29T00:00:00.250Z");
    let runAgentCalls = 0;
    const runner = createRunner(store, {
      async runAgent(spec) {
        runAgentCalls += 1;
        expect(spec.outputSchema).toBeUndefined();
        expect(spec.markdownOnly).toBe(true);
        return { taskId: "task_legacy_unstarted", reportMarkdown: "summary" };
      },
    });

    await expect(runner.run("wfr_legacy_unstarted_schema")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
    expect(runAgentCalls).toBe(1);
  });

  test("runs markdown-only agent steps in new non-pending workflow runs", async () => {
    using tmp = new DisposableTempDir("workflow-runner-new-nonpending-missing-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_new_nonpending_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Missing schema", { id: "missing-schema" });
  return { reportMarkdown: summary };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await store.appendStatus("wfr_new_nonpending_schema", "running", "2026-05-29T00:00:00.250Z");
    const runAgentSpecs: WorkflowAgentSpec[] = [];
    const runAgent = mock(async (spec: WorkflowAgentSpec) => {
      runAgentSpecs.push(spec);
      return {
        taskId: "task_1",
        reportMarkdown: "summary",
        structuredOutput: {},
      };
    });
    const runner = createRunner(store, { runAgent });

    await expect(runner.run("wfr_new_nonpending_schema")).resolves.toEqual({
      reportMarkdown: "summary",
    });
    expect(runAgentSpecs).toEqual([
      expect.objectContaining({ id: "missing-schema", markdownOnly: true }),
    ]);
  });

  test("backfills completed task events when replaying completed agent steps", async () => {
    using tmp = new DisposableTempDir("workflow-runner-completed-task-event-backfill");
    const store = await createRunStore(tmp.path);
    const spec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepCompleted("wfr_123", {
      stepId: spec.id,
      inputHash: hashWorkflowStepInput(spec.id, spec),
      taskId: "task_completed_missing_event",
      result: {
        taskId: "task_completed_missing_event",
        reportMarkdown: "summary",
        structuredOutput: {},
      },
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
    const spec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
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
        return { taskId: "task_duplicate", reportMarkdown: "duplicate", structuredOutput: {} };
      },
      async waitForAgentTask(taskId, _spec, waitOptions) {
        waitedFor.push(taskId);
        waitTimeoutMs = waitOptions?.timeoutMs;
        waitAbortSignal = waitOptions?.abortSignal;
        expect(waitAbortSignal?.aborted).toBe(false);
        return { taskId, reportMarkdown: "summary", structuredOutput: {} };
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
    expect(waitAbortSignal).toBeDefined();
  });

  test("adds one started task event when resuming legacy started steps", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-started-event");
    const store = await createRunStore(tmp.path);
    const spec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
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
        return { taskId, reportMarkdown: "summary", structuredOutput: {} };
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
    const spec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
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
        return { taskId: "task_recovered", reportMarkdown: "summary", structuredOutput: {} };
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

  test("respawns stale started legacy markdown-only steps without outputSchema", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-stale-started-invalid-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_stale_started_invalid_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    await store.appendStatus(
      "wfr_legacy_stale_started_invalid_schema",
      "running",
      "2026-05-29T00:00:00.250Z"
    );
    const legacySpec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepStarted("wfr_legacy_stale_started_invalid_schema", {
      stepId: legacySpec.id,
      inputHash: hashWorkflowStepInput(legacySpec.id, legacySpec),
      taskId: "task_legacy_missing",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    const waitedFor: string[] = [];
    const runner = createRunner(store, {
      async runAgent(spec) {
        expect(spec.outputSchema).toBeUndefined();
        return { taskId: "task_legacy_recovered", reportMarkdown: "summary" };
      },
      async waitForAgentTask(taskId) {
        waitedFor.push(taskId);
        throw new Error("Task not found");
      },
    });

    await expect(runner.run("wfr_legacy_stale_started_invalid_schema")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
    expect(waitedFor).toEqual(["task_legacy_missing"]);
  });

  test("recovers stale started legacy markdown-only agent steps", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-stale-started");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_stale_started",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    await store.appendStatus("wfr_legacy_stale_started", "running", "2026-05-29T00:00:00.250Z");
    const legacySpec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepStarted("wfr_legacy_stale_started", {
      stepId: legacySpec.id,
      inputHash: hashWorkflowStepInput(legacySpec.id, legacySpec),
      taskId: "task_legacy_missing",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    const waitedFor: string[] = [];
    let runAgentCalls = 0;
    const runner = createRunner(store, {
      async runAgent(spec) {
        runAgentCalls += 1;
        expect(spec.outputSchema).toBeUndefined();
        expect(spec.markdownOnly).toBe(true);
        return { taskId: "task_legacy_recovered", reportMarkdown: "summary" };
      },
      async waitForAgentTask(taskId) {
        waitedFor.push(taskId);
        throw new Error("Task not found");
      },
    });

    await expect(runner.run("wfr_legacy_stale_started")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });

    expect(waitedFor).toEqual(["task_legacy_missing"]);
    expect(runAgentCalls).toBe(1);
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
    const spec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
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
        return { taskId: "task_restarted", reportMarkdown: "summary", structuredOutput: {} };
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

  test("retries workflow agent steps that fail structured output validation", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_retry_validation",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
        const result = agent("Extract claims", {
          id: "claims",
          schema: {
            type: "object",
            required: ["claims"],
            properties: { claims: { type: "array", items: { type: "string" } } },
            additionalProperties: false,
          },
        });
        return { reportMarkdown: result.claims.join(", ") };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const prompts: string[] = [];
    const runner = createRunner(store, {
      async runAgent(spec) {
        prompts.push(spec.prompt);
        if (prompts.length === 1) {
          return { taskId: "task_bad", reportMarkdown: "bad", structuredOutput: {} };
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
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_retry_exhausted",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
        return agent("Extract claims", {
          id: "claims",
          schema: { type: "object", required: ["claims"], properties: { claims: { type: "array" } } },
        });
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    let calls = 0;
    const runner = createRunner(store, {
      async runAgent() {
        calls += 1;
        return { taskId: `task_bad_${calls}`, reportMarkdown: "bad", structuredOutput: {} };
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
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
        return agent("Extract claims", {
          id: "claims",
          schema: {
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
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_limits",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow() { return { reportMarkdown: "limited" }; }`,
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
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_async",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default async function workflow() { return { reportMarkdown: "async ok" }; }`,
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

  test("supports top-level named export declarations alongside the default export", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_named_exports",
      workspaceId: "workspace-1",
      workflow: definition,
      // Built-in workflows export pure helpers for direct unit testing; the
      // compiler must strip those export modifiers before script evaluation.
      source: [
        `export const GREETING = "named";`,
        `export class Exclaimer {`,
        `  render(value) { return value + "!"; }`,
        `}`,
        `export function exclaim(value) { return new Exclaimer().render(value); }`,
        `export async function emphasize(value) { return value.toUpperCase(); }`,
        `export default async function workflow() {`,
        `  return { reportMarkdown: await emphasize(exclaim(GREETING)) };`,
        `}`,
      ].join("\n"),
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not run");
      },
    });

    await expect(runner.run("wfr_named_exports")).resolves.toEqual({ reportMarkdown: "NAMED!" });
  });

  test("returns the normalized workflow result for JSON-serializable values", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_normalized_return",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow() { return { summary: "done" }; }`,
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
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_empty_return",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow() {}`,
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
          return { taskId: "task_1", reportMarkdown: "late summary", structuredOutput: {} };
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
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_compile_error",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default () => ({ reportMarkdown: "bad shape" });`,
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
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_missing_id",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) { return agent("no id", {}); }`,
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

  test("exposes mux helpers without filesystem imports or timers to workflow code", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_forbidden",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow() {
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
      mux: "object",
      require: "undefined",
      setTimeout: "undefined",
      Date: "undefined",
      random: "undefined",
    });
  });
});
