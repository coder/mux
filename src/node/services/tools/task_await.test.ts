import * as fs from "fs";

import { describe, it, expect, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { createTaskAwaitTool } from "./task_await";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import { getSubagentGitPatchArtifactsFilePath } from "@/node/services/subagentGitPatchArtifacts";
import { ForegroundWaitBackgroundedError, type TaskService } from "@/node/services/taskService";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

describe("task_await tool", () => {
  it("includes gitFormatPatch artifacts written during waitForAgentReport", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-artifacts");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const workspaceSessionDir = baseConfig.workspaceSessionDir;
    if (!workspaceSessionDir) {
      throw new Error("Expected workspaceSessionDir to be set in test tool config");
    }
    const artifactsPath = getSubagentGitPatchArtifactsFilePath(workspaceSessionDir);

    const gitFormatPatch = {
      childTaskId: "t1",
      parentWorkspaceId: "parent-workspace",
      createdAtMs: 123,
      status: "pending",
    } as const;

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport: mock(async (taskId: string) => {
        await fs.promises.writeFile(
          artifactsPath,
          JSON.stringify(
            {
              version: 1,
              artifactsByChildTaskId: { [taskId]: gitFormatPatch },
            },
            null,
            2
          ),
          "utf-8"
        );

        return { reportMarkdown: "ok" };
      }),
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "ok",
          title: undefined,
          artifacts: { gitFormatPatch },
        },
      ],
    });
  });
  it("returns completed results for all awaited tasks", async () => {
    using tempDir = new TestTempDir("test-task-await-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock((taskId: string) =>
      Promise.resolve({ reportMarkdown: `report:${taskId}`, title: `title:${taskId}` })
    );
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1", "t2"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport,
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
    expect(waitForAgentReport).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        backgroundOnMessageQueued: true,
      })
    );
    expect(waitForAgentReport).toHaveBeenCalledWith(
      "t2",
      expect.objectContaining({
        backgroundOnMessageQueued: true,
      })
    );
  });

  it("supports filterDescendantAgentTaskIds without losing this binding", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-this-binding");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ok" }));
    const isDescendantAgentTask = mock(() => Promise.resolve(true));

    const taskService = {
      filterDescendantAgentTaskIds: function (ancestorWorkspaceId: string, taskIds: string[]) {
        expect(this).toBe(taskService);
        expect(ancestorWorkspaceId).toBe("parent-workspace");
        expect(taskIds).toEqual(["t1"]);
        return Promise.resolve(taskIds);
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

    const getAgentTaskStatuses = mock((taskIds: string[]) => {
      expect(taskIds).toEqual(["other"]);
      return new Map([["other", { exists: true, taskStatus: "running" as const }]]);
    });
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["child"]),
      isDescendantAgentTask,
      getAgentTaskStatuses,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["child", "other"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        { status: "completed", taskId: "child", reportMarkdown: "ok", title: undefined },
        { status: "invalid_scope", taskId: "other", activeTaskIds: ["child"] },
      ],
    });
    expect(waitForAgentReport).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledWith("child", expect.any(Object));
    expect(getAgentTaskStatuses).toHaveBeenCalledTimes(1);
  });

  it("returns not_found with activeTaskIds when a requested taskId is hallucinated", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-hallucinated-not-found");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => {
      throw new Error("waitForAgentReport should not be called for hallucinated task IDs");
    });
    const getAgentTaskStatuses = mock((taskIds: string[]) => {
      expect(taskIds).toEqual(["hallucinated"]);
      return new Map([["hallucinated", { exists: false, taskStatus: null }]]);
    });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["real-child"]),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["hallucinated"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "not_found",
          taskId: "hallucinated",
          activeTaskIds: ["real-child"],
        },
      ],
    });
    expect(getAgentTaskStatuses).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledTimes(0);
  });

  it("returns invalid_scope with activeTaskIds when a requested task exists globally", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-invalid-scope-active-hint");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => {
      throw new Error("waitForAgentReport should not be called for out-of-scope task IDs");
    });
    const getAgentTaskStatuses = mock((taskIds: string[]) => {
      expect(taskIds).toEqual(["other-workspace"]);
      return new Map([["other-workspace", { exists: true, taskStatus: "running" as const }]]);
    });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["real-child"]),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["other-workspace"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "invalid_scope",
          taskId: "other-workspace",
          activeTaskIds: ["real-child"],
        },
      ],
    });
    expect(getAgentTaskStatuses).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledTimes(0);
  });

  it("batches status lookups for multiple out-of-scope task IDs", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-batched-status-lookups");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => {
      throw new Error("waitForAgentReport should not be called for out-of-scope task IDs");
    });
    const getAgentTaskStatuses = mock((taskIds: string[]) => {
      expect(taskIds).toEqual(["external-1", "external-2"]);
      return new Map([
        ["external-1", { exists: true, taskStatus: "running" as const }],
        ["external-2", { exists: false, taskStatus: null }],
      ]);
    });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["real-child"]),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["external-1", "external-2"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        { status: "invalid_scope", taskId: "external-1", activeTaskIds: ["real-child"] },
        { status: "not_found", taskId: "external-2", activeTaskIds: ["real-child"] },
      ],
    });
    expect(getAgentTaskStatuses).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledTimes(0);
  });

  it("defaults to waiting on all active descendant tasks when task_ids is omitted", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-descendants");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const listActiveDescendantAgentTaskIds = mock(() => ["t1"]);
    const isDescendantAgentTask = mock(() => Promise.resolve(true));
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

  it("returns running status when foreground wait is backgrounded", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-backgrounded");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => Promise.reject(new ForegroundWaitBackgroundedError()));
    const getAgentTaskStatus = mock(() => "running" as const);

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport,
      getAgentTaskStatus,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "running",
          taskId: "t1",
          note: "Task sent to background because a new message was queued. Use task_await to monitor progress.",
        },
      ],
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
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
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

  it("treats timeout_secs=0 as non-blocking for agent tasks", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-timeout-zero");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => {
      throw new Error("waitForAgentReport should not be called for timeout_secs=0");
    });
    const getAgentTaskStatus = mock(() => "running" as const);

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      getAgentTaskStatus,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ timeout_secs: 0 }, mockToolCallOptions)
    );

    expect(result).toEqual({ results: [{ status: "running", taskId: "t1" }] });
    expect(waitForAgentReport).toHaveBeenCalledTimes(0);
    expect(getAgentTaskStatus).toHaveBeenCalledWith("t1");
  });

  it("returns completed result when timeout_secs=0 and a cached report is available", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-timeout-zero-cached");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const getAgentTaskStatus = mock(() => null);
    const waitForAgentReport = mock(() =>
      Promise.resolve({ reportMarkdown: "ok", title: "cached-title" })
    );

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      getAgentTaskStatus,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ timeout_secs: 0 }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "ok",
          title: "cached-title",
        },
      ],
    });
    expect(getAgentTaskStatus).toHaveBeenCalledWith("t1");
    expect(waitForAgentReport).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        backgroundOnMessageQueued: true,
      })
    );
  });
});
