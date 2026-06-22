/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, mock, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import { COMPLETED_REPORT_REFETCH_NOTE } from "@/common/utils/tools/toolDefinitions";
import { createWorkflowRunTool } from "./workflow_run";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import { readAgentWorkflowRunReferences } from "@/node/services/agentWorkflowRunReferences";
import type { WorkflowRunAttachedEvent } from "@/common/types/stream";
import type { WorkflowRunRecord } from "@/common/types/workflow";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

async function writeWorkflowScript(root: string): Promise<string> {
  const relativePath = "workflows/deep-research.js";
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "export default function workflow() { return null; }\n", "utf-8");
  return `./${relativePath}`;
}

function createWorkflowRunRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: "wfr_123",
    workspaceId: "workspace-1",
    workflow: {
      name: "deep-research",
      description: "Deep research",
      scope: "project",
      executable: true,
    },
    source: "export default function workflow() { return null; }",
    sourceHash: "sha256:test",
    args: { topic: "workflow tools" },
    status: "pending",
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    events: [
      {
        sequence: 1,
        type: "status",
        at: "2026-05-29T00:00:00.000Z",
        status: "pending",
      },
    ],
    steps: [],
    ...overrides,
  };
}

describe("workflow_run tool", () => {
  test("starts an explicit script_path workflow through WorkflowService", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const startWorkflow = mock(async () => ({
      runId: "wfr_123",
      status: "completed" as const,
      result: { reportMarkdown: "done" },
    }));
    const getRun = mock(async () =>
      createWorkflowRunRecord({
        status: "completed",
        updatedAt: "2026-05-29T00:00:01.000Z",
        events: [
          {
            sequence: 1,
            type: "status" as const,
            at: "2026-05-29T00:00:00.000Z",
            status: "running" as const,
          },
          { sequence: 2, type: "phase" as const, at: "2026-05-29T00:00:00.000Z", name: "scope" },
          {
            sequence: 3,
            type: "result" as const,
            at: "2026-05-29T00:00:01.000Z",
            result: { reportMarkdown: "done" },
          },
          {
            sequence: 4,
            type: "status" as const,
            at: "2026-05-29T00:00:01.000Z",
            status: "completed" as const,
          },
        ],
      })
    );
    const abortController = new AbortController();
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        startWorkflow,
        getRun,
      },
    });

    const result = await tool.execute!(
      { script_path: scriptPath, args: { topic: "workflow tools" }, run_in_background: false },
      { ...mockToolCallOptions, abortSignal: abortController.signal }
    );

    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        script: expect.objectContaining({
          requestedScriptPath: scriptPath,
          sourceKind: "workspace-file",
          source: expect.stringContaining("export default"),
        }),
        workspaceId: "workspace-1",
        projectTrusted: true,
        args: { topic: "workflow tools" },
        abortSignal: abortController.signal,
        onRunCreated: expect.any(Function),
      })
    );
    expect(getRun).toHaveBeenCalledWith({ workspaceId: "workspace-1", runId: "wfr_123" });
    expect(result).toEqual({
      status: "completed",
      runId: "wfr_123",
      result: { reportMarkdown: "done" },
      run: expect.objectContaining({
        id: "wfr_123",
        status: "completed",
        events: expect.arrayContaining([expect.objectContaining({ type: "phase", name: "scope" })]),
      }),
      note: COMPLETED_REPORT_REFETCH_NOTE,
    });
  });

  test("resolves relative workflow script paths from the active tool cwd", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-active-cwd");
    const activeRoot = path.join(tempDir.path, "active-worktree");
    const staleRoot = path.join(tempDir.path, "source-project");
    await fs.mkdir(path.join(activeRoot, "workflows"), { recursive: true });
    await fs.mkdir(path.join(staleRoot, "workflows"), { recursive: true });
    await fs.writeFile(
      path.join(activeRoot, "workflows", "deep-research.js"),
      "export default function workflow() { return 'active'; }\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(staleRoot, "workflows", "deep-research.js"),
      "export default function workflow() { return 'stale'; }\n",
      "utf-8"
    );
    let capturedSource = "";
    const startWorkflow = mock(async (input: { script: { source: string } }) => {
      capturedSource = input.script.source;
      return {
        runId: "wfr_active_cwd",
        status: "completed" as const,
        result: { reportMarkdown: "done" },
      };
    });
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(activeRoot, { workspaceId: "workspace-1" }),
      workspaceExecutionRootPath: staleRoot,
      trusted: true,
      workflowService: {
        startWorkflow,
        getRun: mock(async () => null),
      },
    });

    await tool.execute!(
      {
        script_path: "./workflows/deep-research.js",
        args: {},
        run_in_background: false,
      },
      mockToolCallOptions
    );

    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        script: expect.objectContaining({
          source: expect.stringContaining("active"),
        }),
      })
    );
    expect(capturedSource).not.toContain("stale");
  });

  test("starts a built-in skill workflow by explicit skill script_path", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-built-in-skill");
    const startWorkflow = mock(async () => ({
      runId: "wfr_builtin_skill",
      status: "completed" as const,
      result: { reportMarkdown: "done" },
    }));
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: false,
      workflowService: {
        startWorkflow,
        getRun: mock(async () => null),
      },
    });

    const result = await tool.execute!(
      {
        script_path: "skill://workflow-smoke/workflow.js",
        args: { message: "from tool" },
        run_in_background: false,
      },
      mockToolCallOptions
    );

    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        script: expect.objectContaining({
          requestedScriptPath: "skill://workflow-smoke/workflow.js",
          canonicalScriptPath: "skill://workflow-smoke/workflow.js",
          sourceKind: "skill",
          scope: "built-in",
          source: expect.stringContaining("Workflow Smoke"),
        }),
        projectTrusted: false,
        args: { message: "from tool" },
      })
    );
    expect(result).toEqual({
      status: "completed",
      runId: "wfr_builtin_skill",
      result: { reportMarkdown: "done" },
      note: COMPLETED_REPORT_REFETCH_NOTE,
    });
  });

  test("emits a workflow run attachment when the durable run is created", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-attached");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const attachedRun = createWorkflowRunRecord({ id: "wfr_attached" });
    const emittedEvents: WorkflowRunAttachedEvent[] = [];
    let emitChatEventSettled = false;
    let onRunCreatedWaitedForEmission = false;
    const startWorkflow = mock(
      async (input: {
        onRunCreated?: (event: {
          runId: string;
          status: "pending";
          result: null;
          run: unknown;
        }) => Promise<void> | void;
      }) => {
        await input.onRunCreated?.({
          runId: attachedRun.id,
          status: "pending",
          result: null,
          run: attachedRun,
        });
        onRunCreatedWaitedForEmission = emitChatEventSettled;
        return { runId: attachedRun.id, status: "completed" as const, result: null };
      }
    );
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      emitChatEvent: async (event) => {
        await Promise.resolve();
        if (event.type === "workflow-run-attached") {
          emittedEvents.push(event);
          emitChatEventSettled = true;
        }
      },
      workflowService: {
        startWorkflow,
        getRun: mock(async () => attachedRun),
      },
    });

    await tool.execute!(
      { script_path: scriptPath, args: { topic: "workflow tools" }, run_in_background: false },
      mockToolCallOptions
    );

    expect(onRunCreatedWaitedForEmission).toBe(true);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      type: "workflow-run-attached",
      workspaceId: "workspace-1",
      toolCallId: "test-call-id",
      runId: "wfr_attached",
      run: expect.objectContaining({ id: "wfr_attached", status: "pending" }),
    });
    expect(typeof emittedEvents[0]?.timestamp).toBe("number");
  });

  test("starts an explicit script_path workflow in background mode", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-background");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const startWorkflow = mock(async () => {
      throw new Error("foreground start should not be used");
    });
    const startWorkflowInBackground = mock(async () => ({
      runId: "wfr_background",
      status: "running" as const,
      result: null,
    }));
    const getRun = mock(async () => null);
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        startWorkflow,
        startWorkflowInBackground,
        getRun,
      },
    });

    const result = await tool.execute!(
      { script_path: scriptPath, args: { topic: "workflow tools" }, run_in_background: true },
      mockToolCallOptions
    );

    const references = await readAgentWorkflowRunReferences(tempDir.path);
    expect(references.map((reference) => reference.runId)).toContain("wfr_background");

    expect(startWorkflowInBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        script: expect.objectContaining({ requestedScriptPath: scriptPath }),
        workspaceId: "workspace-1",
        projectTrusted: true,
        args: { topic: "workflow tools" },
        onRunCreated: expect.any(Function),
      })
    );
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "running", runId: "wfr_background", result: null });
  });

  test("requires the workflow service", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-missing");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
    });

    await expect(
      Promise.resolve(
        tool.execute!(
          { script_path: scriptPath, args: {}, run_in_background: false },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow(/workflowService/);
  });
});
