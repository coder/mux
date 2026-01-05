import { describe, it, expect, mock } from "bun:test";
import type { ToolCallOptions } from "ai";

import { createTaskTerminateTool } from "./task_terminate";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { TaskService } from "@/node/services/taskService";
import { Err, Ok, type Result } from "@/common/types/result";

const mockToolCallOptions: ToolCallOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

describe("task_terminate tool", () => {
  it("returns not_found when the task does not exist", async () => {
    using tempDir = new TestTempDir("test-task-terminate-not-found");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const taskService = {
      terminateDescendantAgentTask: mock(
        (): Promise<Result<{ terminatedTaskIds: string[] }, string>> =>
          Promise.resolve(Err("Task not found"))
      ),
    } as unknown as TaskService;

    const tool = createTaskTerminateTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["missing-task"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "not_found", taskId: "missing-task" }],
    });
  });

  it("returns invalid_scope when the task is outside the workspace scope", async () => {
    using tempDir = new TestTempDir("test-task-terminate-invalid-scope");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const taskService = {
      terminateDescendantAgentTask: mock(
        (): Promise<Result<{ terminatedTaskIds: string[] }, string>> =>
          Promise.resolve(Err("Task is not a descendant of this workspace"))
      ),
    } as unknown as TaskService;

    const tool = createTaskTerminateTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["other-task"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "invalid_scope", taskId: "other-task" }],
    });
  });

  it("returns terminated with terminatedTaskIds on success", async () => {
    using tempDir = new TestTempDir("test-task-terminate-ok");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const taskService = {
      terminateDescendantAgentTask: mock(
        (): Promise<Result<{ terminatedTaskIds: string[] }, string>> =>
          Promise.resolve(Ok({ terminatedTaskIds: ["child-task", "parent-task"] }))
      ),
    } as unknown as TaskService;

    const tool = createTaskTerminateTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["parent-task"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "terminated",
          taskId: "parent-task",
          terminatedTaskIds: ["child-task", "parent-task"],
        },
      ],
    });
  });
});
