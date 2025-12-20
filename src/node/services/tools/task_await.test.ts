import { describe, it, expect, mock } from "bun:test";
import type { ToolCallOptions } from "ai";

import { createTaskAwaitTool } from "./task_await";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { TaskService } from "@/node/services/taskService";

const mockToolCallOptions: ToolCallOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

describe("task_await tool", () => {
  it("returns completed results for all awaited tasks", async () => {
    using tempDir = new TestTempDir("test-task-await-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1", "t2"]),
      isDescendantAgentTask: mock(() => true),
      waitForAgentReport: mock((taskId: string) =>
        Promise.resolve({ reportMarkdown: `report:${taskId}`, title: `title:${taskId}` })
      ),
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1", "t2"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        { status: "completed", taskId: "t1", reportMarkdown: "report:t1", title: "title:t1" },
        { status: "completed", taskId: "t2", reportMarkdown: "report:t2", title: "title:t2" },
      ],
    });
  });

  it("supports filterDescendantAgentTaskIds without losing this binding", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-this-binding");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ok" }));
    const isDescendantAgentTask = mock(() => true);

    const taskService = {
      filterDescendantAgentTaskIds: function (ancestorWorkspaceId: string, taskIds: string[]) {
        expect(this).toBe(taskService);
        expect(ancestorWorkspaceId).toBe("parent-workspace");
        expect(taskIds).toEqual(["t1"]);
        return taskIds;
      },
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "completed", taskId: "t1", reportMarkdown: "ok", title: undefined }],
    });
    expect(isDescendantAgentTask).toHaveBeenCalledTimes(0);
    expect(waitForAgentReport).toHaveBeenCalledTimes(1);
  });

  it("marks invalid_scope without calling waitForAgentReport", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-invalid-scope");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const isDescendantAgentTask = mock((ancestorId: string, taskId: string) => {
      expect(ancestorId).toBe("parent-workspace");
      return taskId !== "other";
    });
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ok" }));

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["child", "other"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        { status: "completed", taskId: "child", reportMarkdown: "ok", title: undefined },
        { status: "invalid_scope", taskId: "other" },
      ],
    });
    expect(waitForAgentReport).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledWith("child", expect.any(Object));
  });

  it("defaults to waiting on all active descendant tasks when task_ids is omitted", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-descendants");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const listActiveDescendantAgentTaskIds = mock(() => ["t1"]);
    const isDescendantAgentTask = mock(() => true);
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ok" }));

    const taskService = {
      listActiveDescendantAgentTaskIds,
      isDescendantAgentTask,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(listActiveDescendantAgentTaskIds).toHaveBeenCalledWith("parent-workspace");
    expect(result).toEqual({
      results: [{ status: "completed", taskId: "t1", reportMarkdown: "ok", title: undefined }],
    });
  });

  it("maps wait errors to running/not_found/error statuses", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-errors");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock((taskId: string) => {
      if (taskId === "timeout") {
        return Promise.reject(new Error("Timed out waiting for agent_report"));
      }
      if (taskId === "missing") {
        return Promise.reject(new Error("Task not found"));
      }
      return Promise.reject(new Error("Boom"));
    });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => true),
      getAgentTaskStatus: mock((taskId: string) => (taskId === "timeout" ? "running" : null)),
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["timeout", "missing", "boom"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        { status: "running", taskId: "timeout" },
        { status: "not_found", taskId: "missing" },
        { status: "error", taskId: "boom", error: "Boom" },
      ],
    });
  });
});
