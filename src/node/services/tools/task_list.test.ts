import { describe, it, expect, mock } from "bun:test";
import type { ToolCallOptions } from "ai";

import { createTaskListTool } from "./task_list";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { TaskService } from "@/node/services/taskService";

const mockToolCallOptions: ToolCallOptions = {
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
      statuses: ["queued", "running", "awaiting_report"],
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
});
