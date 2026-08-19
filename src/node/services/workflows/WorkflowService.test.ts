/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/require-await */
import * as crypto from "node:crypto";
import * as path from "node:path";

import { describe, expect, mock, test } from "bun:test";
import assert from "@/common/utils/assert";
import { WORKFLOW_CHECKPOINT_RETRY_ERROR_MESSAGE } from "@/common/utils/workflowRetryEligibility";
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
  test("does not create a durable run when the workspace lifecycle lock rejects startup", async () => {
    using tmp = new DisposableTempDir("workflow-service-run-creation-lock");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const withRunStartLock = mock(async () => {
      throw new Error("Cannot start workflow work after task_stop");
    });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      withRunStartLock,
      generateRunId: () => "wfr_rejected_start",
      runnerId: "runner-a",
    });

    await expect(
      service.startWorkflow({
        script: createScript("export default function workflow() { return 'unused'; }"),
        workspaceId: "workspace-1",
        projectTrusted: true,
        args: {},
      })
    ).rejects.toThrow("Cannot start workflow work after task_stop");
    expect(withRunStartLock).toHaveBeenCalledTimes(1);
    expect(await runStore.listRunStatusSnapshots()).toEqual([]);
  });

  test("does not resume a durable run when the workspace lifecycle lock rejects startup", async () => {
    using tmp = new DisposableTempDir("workflow-service-resume-lock");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_rejected_resume",
      workspaceId: "workspace-1",
      workflow: { name: "demo", description: "Demo", scope: "project", executable: true },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_rejected_resume", "interrupted", "2026-05-29T00:00:01.000Z");
    const withRunStartLock = mock(async () => {
      throw new Error("Cannot start workflow work after task_stop");
    });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      withRunStartLock,
      runnerId: "runner-a",
    });

    await expect(
      service.resumeRunInBackground({
        workspaceId: "workspace-1",
        runId: "wfr_rejected_resume",
        projectTrusted: true,
      })
    ).rejects.toThrow("Cannot start workflow work after task_stop");
    expect(withRunStartLock).toHaveBeenCalledTimes(1);
    expect((await runStore.getRun("wfr_rejected_resume")).status).toBe("interrupted");
  });

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

  test("persists inline workflow source with project-scoped virtual provenance", async () => {
    using tmp = new DisposableTempDir("workflow-service-inline-source");
    const source = `export default function workflow({ args }) {
  return { reportMarkdown: "Inline " + args.value };
}
`;
    const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
    const virtualPath = `inline://workflow-${sourceHash.slice(0, 12)}.js`;
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      generateRunId: () => "wfr_inline_source",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startWorkflow({
      script: createScript(source, {
        requestedScriptPath: virtualPath,
        canonicalScriptPath: virtualPath,
        sourceHash,
        sourceKind: "inline",
      }),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: { value: "ok" },
    });

    const loaded = await runStore.getRun("wfr_inline_source");
    expect(result).toEqual({
      runId: "wfr_inline_source",
      status: "completed",
      result: { reportMarkdown: "Inline ok" },
    });
    expect(loaded.source).toBe(source);
    expect(loaded.sourceHash).toBe(`sha256:${sourceHash}`);
    expect(loaded.workflow).toMatchObject({
      name: `inline-${sourceHash.slice(0, 12)}`,
      description: `Workflow script ${virtualPath}`,
      scope: "project",
      sourcePath: virtualPath,
      requestedScriptPath: virtualPath,
      canonicalScriptPath: virtualPath,
      sourceKind: "inline",
      sourceHash,
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

  test("background workflow starts persist notify_on_terminal policy", async () => {
    using tmp = new DisposableTempDir("workflow-service-background-notify");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      generateRunId: () => "wfr_background_notify",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startWorkflowInBackground({
      script: createScript(
        `export default function workflow() { return { reportMarkdown: "done" }; }\n`
      ),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });

    expect(result).toMatchObject({
      runId: "wfr_background_notify",
      status: "running",
      result: null,
    });
    await expect(runStore.getRun("wfr_background_notify")).resolves.toMatchObject({
      attentionPolicy: "notify_on_terminal",
    });
  });

  test("holds the lifecycle lock until a background start is durably running", async () => {
    using tmp = new DisposableTempDir("workflow-service-background-start-lock");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    let lockHeld = false;
    const events: string[] = [];
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      withRunStartLock: async (_workspaceId, operation) => {
        lockHeld = true;
        events.push("lock:start");
        try {
          return await operation();
        } finally {
          events.push("lock:end");
          lockHeld = false;
        }
      },
      generateRunId: () => "wfr_background_lock",
      runnerId: "runner-a",
    });

    await service.startWorkflowInBackground({
      script: createScript(
        `export default function workflow() { return { reportMarkdown: "done" }; }\n`
      ),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
      onRunCreated: ({ status }) => {
        expect(lockHeld).toBe(true);
        expect(status).toBe("pending");
        events.push("created:pending");
      },
      onBackgroundRunCreated: ({ status, run }) => {
        expect(lockHeld).toBe(true);
        expect(status).toBe("running");
        expect(run.status).toBe("running");
        events.push("created:running");
      },
    });

    expect(lockHeld).toBe(false);
    expect(events).toEqual(["lock:start", "created:pending", "created:running", "lock:end"]);
  });

  test("foreground workflows that self-background persist notify_on_terminal policy", async () => {
    using tmp = new DisposableTempDir("workflow-service-self-background-notify");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    let agentCalls = 0;
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          agentCalls += 1;
          if (agentCalls === 1) {
            throw new ForegroundWaitBackgroundedError();
          }
          return {
            taskId: "task-resumed",
            reportMarkdown: "resumed",
            structuredOutput: { summary: "resumed" },
          };
        },
      },
      generateRunId: () => "wfr_self_background_notify",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startWorkflow({
      script: createScript(`export default async function workflow({ agent }) {
  const child = await agent("Wait for queued message", {
    id: "wait-for-queue",
    schema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
  });
  return { reportMarkdown: child.summary };
}
`),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });

    expect(result).toEqual({
      runId: "wfr_self_background_notify",
      status: "backgrounded",
      result: null,
    });
    await expect(runStore.getRun("wfr_self_background_notify")).resolves.toMatchObject({
      attentionPolicy: "notify_on_terminal",
    });
  });

  test("background checkpoint retry persists notify_on_terminal policy", async () => {
    using tmp = new DisposableTempDir("workflow-service-checkpoint-retry-notify");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_checkpoint_retry_notify",
      workspaceId: "workspace-1",
      workflow: {
        name: "demo",
        description: "Workflow script ./workflows/demo.js",
        scope: "project",
        executable: true,
      },
      source: `export default function workflow() { return { reportMarkdown: "retried" }; }\n`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus(
      "wfr_checkpoint_retry_notify",
      "running",
      "2026-05-29T00:00:01.000Z"
    );
    await runStore.appendNextEvent("wfr_checkpoint_retry_notify", {
      type: "error",
      at: "2026-05-29T00:00:02.000Z",
      message: WORKFLOW_CHECKPOINT_RETRY_ERROR_MESSAGE,
    });
    await runStore.appendStatus(
      "wfr_checkpoint_retry_notify",
      "failed",
      "2026-05-29T00:00:03.000Z"
    );

    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:04.000Z",
        nowMs: () => 4_000,
      },
    });

    const result = await service.retryRunFromCheckpointInBackground({
      workspaceId: "workspace-1",
      runId: "wfr_checkpoint_retry_notify",
      projectTrusted: true,
    });

    expect(result).toMatchObject({
      runId: "wfr_checkpoint_retry_notify",
      status: "running",
      result: null,
    });
    await expect(runStore.getRun("wfr_checkpoint_retry_notify")).resolves.toMatchObject({
      attentionPolicy: "notify_on_terminal",
    });
  });

  test("handles foreground resume aborts while the lifecycle lock is still held", async () => {
    using tmp = new DisposableTempDir("workflow-service-resume-abort-lock");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_resume_abort_lock",
      workspaceId: "workspace-1",
      workflow: { name: "demo", description: "Demo", scope: "project", executable: true },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_resume_abort_lock", "interrupted", "2026-05-29T00:00:01.000Z");
    const abortController = new AbortController();
    const events: string[] = [];
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapterFactory: (runId) => ({
        async runAgent() {
          throw new Error("Runner must not start after the resume is aborted");
        },
        interruptRun() {
          events.push(`cleanup:${runId}`);
          return Promise.resolve();
        },
        onRunEnded() {
          events.push(`sweep:${runId}`);
          return Promise.resolve();
        },
      }),
      withRunStartLock: async (_workspaceId, operation) => {
        events.push("lock:start");
        const result = await operation();
        events.push("lock:end");
        return result;
      },
      onRunStatusChanged: (event) => {
        if (event.runId === "wfr_resume_abort_lock" && event.status === "running") {
          abortController.abort();
        }
      },
      runnerId: "runner-a",
    });

    await expect(
      service.resumeRun({
        workspaceId: "workspace-1",
        runId: "wfr_resume_abort_lock",
        projectTrusted: true,
        abortSignal: abortController.signal,
      })
    ).rejects.toThrow("Workflow run interrupted");

    expect(events).toEqual([
      "lock:start",
      "cleanup:wfr_resume_abort_lock",
      "lock:end",
      "sweep:wfr_resume_abort_lock",
    ]);
    expect((await runStore.getRun("wfr_resume_abort_lock")).status).toBe("interrupted");
  });

  test("ignores a terminal race during abort cleanup retry", async () => {
    using tmp = new DisposableTempDir("workflow-service-abort-cleanup-terminal-race");
    const service = new WorkflowService({
      runStore: new WorkflowRunStore({ sessionDir: tmp.path }),
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No runner expected");
        },
      },
      runnerId: "runner-a",
    });
    const interruptRun = mock(() => Promise.reject(new Error("workflow cleanup transition raced")));
    const getRun = mock()
      .mockResolvedValueOnce({ status: "interrupted" })
      .mockResolvedValueOnce({ status: "completed" });
    service.interruptRun = interruptRun;
    service.getRun = getRun;
    const abortController = new AbortController();
    const internal = service as unknown as {
      interruptRunOnAbort: (
        workspaceId: string,
        runId: string,
        abortSignal: AbortSignal,
        runnerAbortController: AbortController | undefined
      ) => { remove: () => void; wait: () => Promise<void> };
    };
    const abortInterrupt = internal.interruptRunOnAbort(
      "workspace-1",
      "wfr_abort_race",
      abortController.signal,
      undefined
    );

    abortController.abort();
    await abortInterrupt.wait();

    expect(interruptRun).toHaveBeenCalledTimes(2);
    expect(getRun).toHaveBeenCalledTimes(2);
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
    const childSource = `export const meta = {
  name: "Child Workflow",
  description: "Nested child",
  argsSchema: {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"]
  }
};
export default function workflow({ args }) {
  return { reportMarkdown: "Child " + args.input };
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

    const childInput = "quoted markdown: I'm testing --not-a-flag";
    const result = await service.startWorkflow({
      script: createScript(`export default function workflow({ workflow }) {
  const child = workflow("./workflows/child.js", { id: "child-step", args: { input: "${childInput}" } });
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

    expect(result.result).toEqual({ reportMarkdown: `Parent saw Child ${childInput}` });
    expect(childRun).toMatchObject({
      workspaceId: "workspace-1",
      status: "completed",
      args: { input: childInput },
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

  test("serializes workflow interruption and defers task sweeps until lock release", async () => {
    using tmp = new DisposableTempDir("workflow-service-interrupt-lock");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_interrupt_lock",
      workspaceId: "workspace-1",
      workflow: { name: "demo", description: "Demo", scope: "project", executable: true },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_interrupt_lock", "running", "2026-05-29T00:00:01.000Z");
    const events: string[] = [];
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapterFactory: (runId) => ({
        async runAgent() {
          throw new Error("No agent steps expected");
        },
        interruptRun() {
          events.push(`cleanup:${runId}`);
          return Promise.resolve();
        },
        onRunEnded() {
          events.push(`sweep:${runId}`);
          return Promise.resolve();
        },
      }),
      withRunStartLock: async (_workspaceId, operation) => {
        events.push("lock:start");
        const result = await operation();
        events.push("lock:end");
        return result;
      },
      runnerId: "runner-a",
    });

    await service.interruptRun({ workspaceId: "workspace-1", runId: "wfr_interrupt_lock" });

    expect(events).toEqual([
      "lock:start",
      "cleanup:wfr_interrupt_lock",
      "lock:end",
      "sweep:wfr_interrupt_lock",
    ]);
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

    const deferredSweepRunIds: string[] = [];
    await service.interruptRun({
      workspaceId: "workspace-1",
      runId: "wfr_parent_interrupt",
      deferTaskSweep: true,
      onRunInterrupted: (runId) => deferredSweepRunIds.push(runId),
    });

    await expect(runStore.getRun("wfr_parent_interrupt")).resolves.toMatchObject({
      status: "interrupted",
    });
    await expect(runStore.getRun("wfr_child_interrupt")).resolves.toMatchObject({
      status: "interrupted",
    });
    expect(deferredSweepRunIds).toEqual(["wfr_parent_interrupt", "wfr_child_interrupt"]);
    const retriedSweepRunIds: string[] = [];
    await service.interruptRun({
      workspaceId: "workspace-1",
      runId: "wfr_parent_interrupt",
      retryTaskCleanup: true,
      deferTaskSweep: true,
      onRunInterrupted: (runId) => retriedSweepRunIds.push(runId),
    });
    expect(retriedSweepRunIds).toEqual(["wfr_parent_interrupt", "wfr_child_interrupt"]);
    expect(interruptedRunIds).toEqual([
      "wfr_parent_interrupt",
      "wfr_child_interrupt",
      "wfr_parent_interrupt",
      "wfr_child_interrupt",
    ]);
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
