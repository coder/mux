import { describe, it, expect, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { createTaskListTool } from "./task_list";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { TaskService } from "@/node/services/taskService";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

describe("task_list tool", () => {
  it("uses default statuses when none are provided", async () => {
    using tempDir = new TestTempDir("test-task-list-default-statuses");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => []);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;

    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(result).toEqual({ tasks: [] });
    expect(listDescendantAgentTasks).toHaveBeenCalledWith("root-workspace", {
      statuses: ["queued", "starting", "running", "awaiting_report"],
      excludeWorkflowTasks: true,
    });
  });

  it("passes through provided statuses", async () => {
    using tempDir = new TestTempDir("test-task-list-statuses");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => []);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;

    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["running"] }, mockToolCallOptions)
    );

    expect(result).toEqual({ tasks: [] });
    expect(listDescendantAgentTasks).toHaveBeenCalledWith("root-workspace", {
      statuses: ["running"],
      excludeWorkflowTasks: true,
    });
  });

  it("returns tasks with metadata", async () => {
    using tempDir = new TestTempDir("test-task-list-ok");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => [
      {
        taskId: "task-1",
        status: "running",
        parentWorkspaceId: "root-workspace",
        agentType: "exec",
        workspaceName: "agent_exec_task-1",
        title: "t",
        createdAt: "2025-01-01T00:00:00.000Z",
        modelString: "anthropic:claude-haiku-4-5",
        thinkingLevel: "low",
        depth: 1,
      },
    ]);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;

    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(result).toEqual({
      tasks: [
        {
          taskId: "task-1",
          status: "running",
          parentWorkspaceId: "root-workspace",
          agentType: "exec",
          workspaceName: "agent_exec_task-1",
          title: "t",
          createdAt: "2025-01-01T00:00:00.000Z",
          modelString: "anthropic:claude-haiku-4-5",
          thinkingLevel: "low",
          depth: 1,
        },
      ],
    });
  });

  it("lists workspace-turn handles with workspace metadata", async () => {
    using tempDir = new TestTempDir("test-task-list-workspace-turns");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => []);
    const listWorkspaceTurnTasks = mock(() => [
      {
        kind: "workspace_turn" as const,
        handleId: "wst_turn",
        ownerWorkspaceId: "root-workspace",
        workspaceId: "child-workspace",
        turnId: "turn-1",
        status: "running" as const,
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:01.000Z",
        createdWorkspace: true,
        disposableWorkspace: false,
        title: "Summary",
      },
    ]);
    const taskService = {
      listDescendantAgentTasks,
      listWorkspaceTurnTasks,
    } as unknown as TaskService;

    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["running"] }, mockToolCallOptions)
    );

    expect(listWorkspaceTurnTasks).toHaveBeenCalledWith("root-workspace", {
      statuses: ["running"],
    });
    expect(result).toEqual({
      tasks: [
        {
          taskId: "wst_turn",
          status: "running",
          parentWorkspaceId: "root-workspace",
          handleKind: "workspace_turn",
          workspaceId: "child-workspace",
          title: "Summary",
          createdAt: "2026-06-19T00:00:00.000Z",
          depth: 1,
        },
      ],
    });
  });

  const buildWorkflowRun = (id: string, status: string) => ({
    id,
    workspaceId: "root-workspace",
    workflow: {
      name: "deep-research",
      description: "Deep research",
      scope: "built-in" as const,
      executable: true,
    },
    source: "export default function workflow() { return null; }",
    sourceHash: "sha256:test",
    args: {},
    status,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:01.000Z",
    events: [],
    steps: [],
  });

  it("includes workflow runs with their native statuses", async () => {
    using tempDir = new TestTempDir("test-task-list-workflows");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => []);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;
    const listRuns = mock(() =>
      Promise.resolve([
        buildWorkflowRun("wfr_active", "backgrounded"),
        // Terminal/interrupted runs are excluded by the default (active) status filter.
        buildWorkflowRun("wfr_done", "completed"),
        buildWorkflowRun("wfr_stopped", "interrupted"),
      ])
    );

    const tool = createTaskListTool({
      ...baseConfig,
      taskService,
      workflowService: {
        listRuns,
      },
    });

    const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(listRuns).toHaveBeenCalledWith({ workspaceId: "root-workspace" });
    expect(result).toEqual({
      tasks: [
        {
          taskId: "wfr_active",
          status: "backgrounded",
          parentWorkspaceId: "root-workspace",
          title: "deep-research",
          createdAt: "2026-05-29T00:00:00.000Z",
          depth: 1,
        },
      ],
    });
  });

  it("discovers resumable workflow runs without querying agent tasks", async () => {
    using tempDir = new TestTempDir("test-task-list-resumable-workflows");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => {
      throw new Error("workflow-only statuses must not hit the agent task index");
    });
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;
    const listRuns = mock(() =>
      Promise.resolve([
        buildWorkflowRun("wfr_running", "running"),
        buildWorkflowRun("wfr_failed", "failed"),
      ])
    );

    const tool = createTaskListTool({
      ...baseConfig,
      taskService,
      workflowService: {
        listRuns,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["failed"] }, mockToolCallOptions)
    );

    expect(listDescendantAgentTasks).not.toHaveBeenCalled();
    expect(result).toEqual({
      tasks: [
        {
          taskId: "wfr_failed",
          status: "failed",
          parentWorkspaceId: "root-workspace",
          title: "deep-research",
          createdAt: "2026-05-29T00:00:00.000Z",
          depth: 1,
        },
      ],
    });
  });
});
