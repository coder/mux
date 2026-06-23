/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/require-await */
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import assert from "@/common/utils/assert";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import { DisposableTempDir } from "@/node/services/tempDir";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { WorkflowService } from "./WorkflowService";
import type { ResolvedWorkflowScript } from "./workflowScriptResolver";

function createScript(
  source: string,
  overrides: Partial<ResolvedWorkflowScript> = {}
): ResolvedWorkflowScript {
  return {
    requestedScriptPath: "./workflows/demo.js",
    canonicalScriptPath: "./workflows/demo.js",
    source,
    sourceHash: "sha256:test",
    sourceKind: "workspace-file",
    resolvedPath: "/workspace/workflows/demo.js",
    ...overrides,
  };
}

describe("WorkflowService", () => {
  test("starts an explicit script workflow and persists the resolved source snapshot", async () => {
    using tmp = new DisposableTempDir("workflow-service-script-path");
    const source = `export default function workflow({ args }) {
  return { reportMarkdown: "Hello " + args.topic };
}
`;
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      generateRunId: () => "wfr_script_path",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startWorkflow({
      script: createScript(source, {
        resolvedPath: path.join(tmp.path, "project", "workflows", "demo.js"),
      }),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: { topic: "script paths" },
    });

    const run = await runStore.getRun("wfr_script_path");
    expect(result).toEqual({
      runId: "wfr_script_path",
      status: "completed",
      result: { reportMarkdown: "Hello script paths" },
    });
    expect(run.source).toBe(source);
    expect(run.sourceHash).not.toBe("sha256:test");
    expect(run.workflow).toMatchObject({
      name: "demo",
      description: "Workflow script ./workflows/demo.js",
      scope: "project",
      sourcePath: "./workflows/demo.js",
      requestedScriptPath: "./workflows/demo.js",
      canonicalScriptPath: "./workflows/demo.js",
      sourceKind: "workspace-file",
      sourceHash: "sha256:test",
      executable: true,
    });
  });

  test("uses workflow meta name and description for the run descriptor", async () => {
    using tmp = new DisposableTempDir("workflow-service-meta-descriptor");
    const source = `export const meta = { name: "Deep Research", description: "Research deeply" };
export default function workflow() { return { reportMarkdown: "done" }; }
`;
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      generateRunId: () => "wfr_meta_descriptor",
      runnerId: "runner-a",
    });

    await service.startWorkflow({
      script: createScript(source),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });

    const run = await runStore.getRun("wfr_meta_descriptor");
    expect(run.workflow).toMatchObject({
      name: "deep-research",
      description: "Research deeply",
    });
  });

  test("ignores legacy metadata export names when building the run descriptor", async () => {
    using tmp = new DisposableTempDir("workflow-service-legacy-metadata-descriptor");
    const legacyMetaIdentifier = "metadata";
    const source = `export const ${legacyMetaIdentifier} = { name: "Legacy Name", description: "Legacy description" };
export default function workflow() { return { reportMarkdown: "done" }; }
`;
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      generateRunId: () => "wfr_legacy_metadata_descriptor",
      runnerId: "runner-a",
    });

    await service.startWorkflow({
      script: createScript(source),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });

    const run = await runStore.getRun("wfr_legacy_metadata_descriptor");
    expect(run.workflow).toMatchObject({
      name: "demo",
      description: "Workflow script ./workflows/demo.js",
    });
  });

  test("notifies run status changes around a foreground script run", async () => {
    using tmp = new DisposableTempDir("workflow-service-status");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const statusEvents: Array<{ workspaceId: string; runId: string; status: string }> = [];
    const service = new WorkflowService({
      runStore,
      onRunStatusChanged: (event) => {
        statusEvents.push(event);
      },
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          return {
            taskId: "task_1",
            reportMarkdown: "child summary",
            structuredOutput: { summary: "child summary" },
          };
        },
      },
      generateRunId: () => "wfr_demo",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startWorkflow({
      script: createScript(`export default async function workflow({ agent }) {
  const child = await agent("Summarize", {
    id: "summarize",
    schema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
  });
  return { reportMarkdown: "Final " + child.summary };
}
`),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });

    expect(result).toEqual({
      runId: "wfr_demo",
      status: "completed",
      result: { reportMarkdown: "Final child summary" },
    });
    expect(statusEvents).toEqual([
      { workspaceId: "workspace-1", runId: "wfr_demo", status: "pending" },
      { workspaceId: "workspace-1", runId: "wfr_demo", status: "completed" },
    ]);
  });

  test("does not continue canceled foreground workflows in the background", async () => {
    using tmp = new DisposableTempDir("workflow-service-canceled-background");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const abortController = new AbortController();
    let runnerFactoryCalls = 0;
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapterFactory: (_runId, workflowName) => {
        if (workflowName != null) {
          runnerFactoryCalls += 1;
        }
        return {
          async runAgent() {
            abortController.abort();
            throw new ForegroundWaitBackgroundedError();
          },
          async interruptRun() {
            // The foreground caller cancellation is expected to interrupt the run.
          },
        };
      },
      generateRunId: () => "wfr_canceled_foreground",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startWorkflow({
      script: createScript(`export default async function workflow({ agent }) {
  await agent("Queue follow-up", {
    id: "queue-follow-up",
    schema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
  });
  return { reportMarkdown: "done" };
}
`),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
      abortSignal: abortController.signal,
    });

    expect(result).toEqual({
      runId: "wfr_canceled_foreground",
      status: "backgrounded",
      result: null,
    });
    expect(runnerFactoryCalls).toBe(1);
    await expect(runStore.getRun("wfr_canceled_foreground")).resolves.toMatchObject({
      status: "interrupted",
    });
  });

  test("runs nested workflow scripts as durable child runs", async () => {
    using tmp = new DisposableTempDir("workflow-service-nested-run");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const childSource = `export const meta = { name: "Child Workflow", description: "Nested child" };
export default function workflow({ args }) {
  return { reportMarkdown: "Child " + args.topic };
}
`;
    const childScript = createScript(childSource, {
      requestedScriptPath: "./workflows/child.js",
      canonicalScriptPath: "./workflows/child.js",
      resolvedPath: path.join(tmp.path, "project", "workflows", "child.js"),
    });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      resolveWorkflowScript: async (scriptPath) => {
        expect(scriptPath).toBe("./workflows/child.js");
        return childScript;
      },
      generateRunId: () => "wfr_parent_nested",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startWorkflow({
      script: createScript(`export default function workflow({ workflow }) {
  const child = workflow("./workflows/child.js", { id: "child-step", args: { topic: "nested" } });
  return { reportMarkdown: "Parent saw " + child.reportMarkdown };
}
`),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });
    const parentRun = await runStore.getRun("wfr_parent_nested");
    const childRunIds = (await runStore.listRunStatusSnapshots())
      .filter((snapshot) => snapshot.parentWorkflow?.runId === "wfr_parent_nested")
      .map((snapshot) => snapshot.id);
    expect(childRunIds).toHaveLength(1);
    const childRunId = childRunIds[0];
    assert(childRunId != null, "nested workflow test must create one child run");
    const childRun = await runStore.getRun(childRunId);

    expect(result.result).toEqual({ reportMarkdown: "Parent saw Child nested" });
    expect(childRun).toMatchObject({
      workspaceId: "workspace-1",
      status: "completed",
      args: { topic: "nested" },
      workflow: { name: "child-workflow", sourcePath: "./workflows/child.js" },
      parentWorkflow: { runId: "wfr_parent_nested", stepId: "child-step" },
    });
    expect(
      parentRun.events.some(
        (event) =>
          event.type === "workflow" &&
          event.stepId === "child-step" &&
          event.runId === childRun.id &&
          event.name === "child-workflow" &&
          event.status === "completed"
      )
    ).toBe(true);
  });

  test("interrupts active child workflow runs with the parent", async () => {
    using tmp = new DisposableTempDir("workflow-service-interrupt-nested-run");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const definition = {
      name: "demo",
      description: "Demo",
      scope: "project",
      sourcePath: "./workflows/demo.js",
      executable: true,
    } as const;
    await runStore.createRun({
      id: "wfr_parent_interrupt",
      workspaceId: "workspace-1",
      workflow: definition,
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.createRun({
      id: "wfr_child_interrupt",
      workspaceId: "workspace-1",
      workflow: definition,
      source: "export default function workflow() { return {}; }\n",
      args: {},
      parentWorkflow: {
        runId: "wfr_parent_interrupt",
        stepId: "child-step",
        inputHash: "child-hash",
        depth: 1,
      },
      now: "2026-05-29T00:00:01.000Z",
    });
    await runStore.appendStatus("wfr_parent_interrupt", "running", "2026-05-29T00:00:02.000Z");
    await runStore.appendStatus("wfr_child_interrupt", "running", "2026-05-29T00:00:03.000Z");
    const interruptedRunIds: string[] = [];
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapterFactory: (runId) => ({
        async runAgent() {
          throw new Error("No agent steps expected");
        },
        async interruptRun() {
          interruptedRunIds.push(runId);
        },
      }),
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:04.000Z",
        nowMs: () => 4_000,
      },
    });

    await service.interruptRun({ workspaceId: "workspace-1", runId: "wfr_parent_interrupt" });

    await expect(runStore.getRun("wfr_parent_interrupt")).resolves.toMatchObject({
      status: "interrupted",
    });
    await expect(runStore.getRun("wfr_child_interrupt")).resolves.toMatchObject({
      status: "interrupted",
    });
    expect(interruptedRunIds).toEqual(["wfr_parent_interrupt", "wfr_child_interrupt"]);
  });

  test("listRuns only loads root runs for the requested workspace", async () => {
    using tmp = new DisposableTempDir("workflow-service-list-runs");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const definition = {
      name: "demo",
      description: "Demo",
      scope: "built-in",
      sourcePath: "skill://demo/workflow.js",
      executable: true,
    } as const;
    await runStore.createRun({
      id: "wfr_workspace_1",
      workspaceId: "workspace-1",
      workflow: definition,
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.createRun({
      id: "wfr_workspace_2",
      workspaceId: "workspace-2",
      workflow: definition,
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:01.000Z",
    });
    await runStore.createRun({
      id: "wfr_workspace_1_child",
      workspaceId: "workspace-1",
      workflow: definition,
      source: "export default function workflow() { return {}; }\n",
      args: {},
      parentWorkflow: {
        runId: "wfr_workspace_1",
        stepId: "child-step",
        inputHash: "child-hash",
        depth: 1,
      },
      now: "2026-05-29T00:00:02.000Z",
    });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      runnerId: "runner-a",
    });

    const runs = await service.listRuns({ workspaceId: "workspace-1" });

    expect(runs.map((run) => run.id)).toEqual(["wfr_workspace_1"]);
  });

  test("rejects resuming untrusted workspace-file workflow runs", async () => {
    using tmp = new DisposableTempDir("workflow-service-trust");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_untrusted",
      workspaceId: "workspace-1",
      workflow: {
        name: "demo",
        description: "Demo",
        scope: "project",
        sourcePath: "./workflows/demo.js",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      runnerId: "runner-a",
    });

    await expect(
      service.resumeRun({
        workspaceId: "workspace-1",
        runId: "wfr_untrusted",
        projectTrusted: false,
      })
    ).rejects.toThrow("Project trust is required");
  });
});
