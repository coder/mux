import * as fs from "fs";

import { describe, it, expect, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { createTaskAwaitTool } from "./task_await";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
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
      status: "ready",
      projectArtifacts: [
        {
          projectPath: "/tmp/project-a",
          projectName: "project-a",
          storageKey: "project-a",
          status: "ready",
          commitCount: 1,
          mboxPath: "/tmp/project-a/series.mbox",
        },
      ],
      readyProjectCount: 1,
      failedProjectCount: 0,
      skippedProjectCount: 0,
      totalCommitCount: 1,
    } as const;

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport: mock(async (taskId: string) => {
        await fs.promises.writeFile(
          artifactsPath,
          JSON.stringify(
            {
              version: 2,
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

  it("normalizes version 1 gitFormatPatch artifacts into a one-project patch set", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-v1-artifacts");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const workspaceSessionDir = baseConfig.workspaceSessionDir;
    if (!workspaceSessionDir) {
      throw new Error("Expected workspaceSessionDir to be set in test tool config");
    }
    const artifactsPath = getSubagentGitPatchArtifactsFilePath(workspaceSessionDir);

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport: mock(async (taskId: string) => {
        await fs.promises.writeFile(
          artifactsPath,
          JSON.stringify(
            {
              version: 1,
              artifactsByChildTaskId: {
                [taskId]: {
                  childTaskId: taskId,
                  parentWorkspaceId: "parent-workspace",
                  createdAtMs: 123,
                  status: "ready",
                  commitCount: 1,
                  mboxPath: "/tmp/legacy-series.mbox",
                },
              },
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
    const result = (await Promise.resolve(
      tool.execute!({ task_ids: ["t1"] }, mockToolCallOptions)
    )) as {
      results: Array<{
        status: string;
        artifacts?: { gitFormatPatch?: { projectArtifacts?: unknown[] } };
      }>;
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe("completed");
    expect(result.results[0]?.artifacts?.gitFormatPatch?.projectArtifacts).toEqual([
      expect.objectContaining({
        projectName: "project",
        storageKey: "legacy-single-project",
        status: "ready",
        commitCount: 1,
      }),
    ]);
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

  it("does not list background bash tasks when explicit agent task IDs are valid", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-explicit-valid-agent-with-bash-manager");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ok" }));
    const listBackgroundProcesses = mock(() => {
      throw new Error(
        "background task discovery should be skipped for valid explicit agent awaits"
      );
    });
    const backgroundProcessManager = {
      list: listBackgroundProcesses,
    } as unknown as BackgroundProcessManager;
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({
      ...baseConfig,
      backgroundProcessManager,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "completed", taskId: "t1", reportMarkdown: "ok", title: undefined }],
    });
    expect(waitForAgentReport).toHaveBeenCalledTimes(1);
    expect(listBackgroundProcesses).toHaveBeenCalledTimes(0);
  });

  it("falls back to not_found when bash suggestion discovery fails", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-suggestion-fallback-on-list-error");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => {
      throw new Error("waitForAgentReport should not be called for hallucinated task IDs");
    });
    const getAgentTaskStatuses = mock((taskIds: string[]) => {
      expect(taskIds).toEqual(["hallucinated"]);
      return new Map([["hallucinated", { exists: false, taskStatus: null }]]);
    });
    const listBackgroundProcesses = mock(() =>
      Promise.reject(new Error("background refresh failed"))
    );
    const backgroundProcessManager = {
      list: listBackgroundProcesses,
    } as unknown as BackgroundProcessManager;
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({
      ...baseConfig,
      backgroundProcessManager,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["hallucinated"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "not_found", taskId: "hallucinated" }],
    });
    expect(getAgentTaskStatuses).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledTimes(0);
    expect(listBackgroundProcesses).toHaveBeenCalledTimes(1);
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

  it("returns an error with descendant task suggestions for hallucinated IDs", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-hallucinated-descendant-suggestions");
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

    const result = (await Promise.resolve(
      tool.execute!({ task_ids: ["hallucinated"] }, mockToolCallOptions)
    )) as { results: Array<{ status: string; taskId: string; error?: string }> };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      status: "error",
      taskId: "hallucinated",
    });
    const descendantSuggestionError = result.results[0]?.error;
    expect(typeof descendantSuggestionError).toBe("string");
    if (typeof descendantSuggestionError !== "string") {
      throw new Error("Expected hallucinated descendant result to include an error message");
    }
    expect(descendantSuggestionError).toContain("same parallel tool-call batch");
    expect(descendantSuggestionError).toContain("real-child");
    expect(getAgentTaskStatuses).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledTimes(0);
  });

  it("returns an error with bash task suggestions for out-of-scope IDs", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-hallucinated-bash-suggestions");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => {
      throw new Error("waitForAgentReport should not be called for out-of-scope task IDs");
    });
    const getAgentTaskStatuses = mock((taskIds: string[]) => {
      expect(taskIds).toEqual(["other-workspace"]);
      return new Map([["other-workspace", { exists: true, taskStatus: "running" as const }]]);
    });

    const backgroundProcessManager = {
      list: mock(() => [
        {
          id: "proc-1",
          workspaceId: "parent-workspace",
          status: "running" as const,
          displayName: "Build",
        },
      ]),
    } as unknown as BackgroundProcessManager;

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({
      ...baseConfig,
      backgroundProcessManager,
      taskService,
    });

    const result = (await Promise.resolve(
      tool.execute!({ task_ids: ["other-workspace"] }, mockToolCallOptions)
    )) as { results: Array<{ status: string; taskId: string; error?: string }> };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      status: "error",
      taskId: "other-workspace",
    });
    const bashSuggestionError = result.results[0]?.error;
    expect(typeof bashSuggestionError).toBe("string");
    if (typeof bashSuggestionError !== "string") {
      throw new Error("Expected out-of-scope bash suggestion result to include an error message");
    }
    expect(bashSuggestionError).toContain("same parallel tool-call batch");
    expect(bashSuggestionError).toContain("bash:proc-1");
    expect(getAgentTaskStatuses).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledTimes(0);
  });

  it("preserves mixed results when one requested ID is real and one is hallucinated", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-mixed-results");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ok" }));
    const getAgentTaskStatuses = mock((taskIds: string[]) => {
      expect(taskIds).toEqual(["hallucinated"]);
      return new Map([["hallucinated", { exists: false, taskStatus: null }]]);
    });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["real-child"]),
      isDescendantAgentTask: mock((ancestorWorkspaceId: string, taskId: string) => {
        expect(ancestorWorkspaceId).toBe("parent-workspace");
        return Promise.resolve(taskId === "real-child");
      }),
      getAgentTaskStatuses,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result = (await Promise.resolve(
      tool.execute!({ task_ids: ["real-child", "hallucinated"] }, mockToolCallOptions)
    )) as {
      results: Array<{
        status: string;
        taskId: string;
        error?: string;
        reportMarkdown?: string;
        title?: string;
      }>;
    };

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      status: "completed",
      taskId: "real-child",
      reportMarkdown: "ok",
      title: undefined,
    });
    expect(result.results[1]).toMatchObject({
      status: "error",
      taskId: "hallucinated",
    });
    const mixedResultError = result.results[1]?.error;
    expect(typeof mixedResultError).toBe("string");
    if (typeof mixedResultError !== "string") {
      throw new Error("Expected mixed-result hallucinated task to include an error message");
    }
    expect(mixedResultError).toContain("real-child");
    expect(waitForAgentReport).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledWith("real-child", expect.any(Object));
    expect(getAgentTaskStatuses).toHaveBeenCalledTimes(1);
  });

  it("keeps not_found when no replacement task IDs are available", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-hallucinated-not-found-no-suggestions");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => {
      throw new Error("waitForAgentReport should not be called for hallucinated task IDs");
    });
    const getAgentTaskStatuses = mock((taskIds: string[]) => {
      expect(taskIds).toEqual(["hallucinated"]);
      return new Map([["hallucinated", { exists: false, taskStatus: null }]]);
    });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
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
        },
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
