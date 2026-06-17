/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await */
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

function createWorkflowRunRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: "wfr_123",
    workspaceId: "workspace-1",
    definition: {
      name: "deep-research",
      description: "Deep research",
      scope: "built-in",
      executable: true,
    },
    definitionSource: "export default function workflow() { return null; }",
    definitionHash: "sha256:test",
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
  test("starts a named workflow through WorkflowService", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool");
    const startNamedWorkflow = mock(async () => ({
      runId: "wfr_123",
      status: "completed" as const,
      result: { reportMarkdown: "done" },
    }));
    const getRun = mock(async () => ({
      id: "wfr_123",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:test",
      args: { topic: "workflow tools" },
      status: "completed" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
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
      steps: [],
    }));
    const abortController = new AbortController();
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        listDefinitions: mock(async () => []),
        readDefinition: mock(async () => ({
          descriptor: {
            name: "deep-research",
            description: "Deep research",
            scope: "built-in",
            executable: true,
          },
          source: "export default function workflow() { return null; }",
        })),
        startNamedWorkflow,
        getRun,
      },
    });

    const result = await tool.execute!(
      { name: "deep-research", args: { topic: "workflow tools" }, run_in_background: false },
      { ...mockToolCallOptions, abortSignal: abortController.signal }
    );

    expect(startNamedWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "deep-research",
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

  test("emits a workflow run attachment when the durable run is created", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-attached");
    const attachedRun = createWorkflowRunRecord({ id: "wfr_attached" });
    const emittedEvents: WorkflowRunAttachedEvent[] = [];
    let emitChatEventSettled = false;
    let onRunCreatedWaitedForEmission = false;
    const startNamedWorkflow = mock(
      async (input: {
        name: string;
        workspaceId: string;
        projectTrusted: boolean;
        args: unknown;
        abortSignal?: AbortSignal;
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
        listDefinitions: mock(async () => []),
        readDefinition: mock(async () => ({
          descriptor: {
            name: "deep-research",
            description: "Deep research",
            scope: "built-in",
            executable: true,
          },
          source: "export default function workflow() { return null; }",
        })),
        startNamedWorkflow,
        getRun: mock(async () => attachedRun),
      },
    });

    await tool.execute!(
      { name: "deep-research", args: { topic: "workflow tools" }, run_in_background: false },
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

  test("starts a workflow in background mode", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-background");
    const startNamedWorkflow = mock(async () => {
      throw new Error("foreground start should not be used");
    });
    const startNamedWorkflowInBackground = mock(async () => ({
      runId: "wfr_background",
      status: "running" as const,
      result: null,
    }));
    const getRun = mock(async () => null);
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: false,
      workflowService: {
        listDefinitions: mock(async () => []),
        readDefinition: mock(async () => ({
          descriptor: {
            name: "deep-research",
            description: "Deep research",
            scope: "built-in",
            executable: true,
          },
          source: "export default function workflow() { return null; }",
        })),
        startNamedWorkflow,
        startNamedWorkflowInBackground,
        getRun,
      },
    });

    const result = await tool.execute!(
      { name: "deep-research", args: { topic: "workflow tools" }, run_in_background: true },
      mockToolCallOptions
    );

    const references = await readAgentWorkflowRunReferences(tempDir.path);
    expect(references.map((reference) => reference.runId)).toContain("wfr_background");

    expect(startNamedWorkflowInBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "deep-research",
        workspaceId: "workspace-1",
        projectTrusted: false,
        args: { topic: "workflow tools" },
        onRunCreated: expect.any(Function),
      })
    );
    expect(startNamedWorkflow).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "running", runId: "wfr_background", result: null });
  });

  test("requires the workflow service", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-missing");
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
    });

    await expect(
      Promise.resolve(
        tool.execute!({ name: "demo", args: {}, run_in_background: false }, mockToolCallOptions)
      )
    ).rejects.toThrow(/workflowService/);
  });
});
