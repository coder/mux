import { describe, it, expect, mock } from "bun:test";
import type { ToolCallOptions } from "ai";

import { createBashTool } from "./bash";
import { createTaskAwaitTool } from "./task_await";
import { createTaskListTool } from "./task_list";
import { createTaskTerminateTool } from "./task_terminate";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { TaskService } from "@/node/services/taskService";

const mockToolCallOptions: ToolCallOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

describe("bash + task_* (background bash tasks)", () => {
  it("bash(run_in_background=true) returns a taskId for background commands", async () => {
    using tempDir = new TestTempDir("test-bash-background");

    const spawn = mock(() => ({
      success: true as const,
      processId: "proc-1",
      outputDir: "ignored",
      pid: 123,
    }));

    const backgroundProcessManager = { spawn } as unknown as BackgroundProcessManager;

    const tool = createBashTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "ws-1" }),
      backgroundProcessManager,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          script: "echo hi",
          timeout_secs: 10,
          run_in_background: true,
          display_name: "My Proc",
        },
        mockToolCallOptions
      )
    );

    expect(spawn).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        exitCode: 0,
        backgroundProcessId: "proc-1",
        taskId: "bash:proc-1",
      })
    );
  });

  it("task_await returns incremental output for bash tasks", async () => {
    using tempDir = new TestTempDir("test-task-await-bash");

    const getProcess = mock(() => ({ id: "proc-1", workspaceId: "ws-1", displayName: "My Proc" }));
    const getOutput = mock(() => ({
      success: true as const,
      status: "running" as const,
      output: "hello",
      elapsed_ms: 5,
    }));

    const backgroundProcessManager = {
      getProcess,
      getOutput,
    } as unknown as BackgroundProcessManager;

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => false),
      waitForAgentReport: mock(() => Promise.resolve({ reportMarkdown: "ignored" })),
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "ws-1" }),
      backgroundProcessManager,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["bash:proc-1"], timeout_secs: 0 }, mockToolCallOptions)
    );

    expect(getProcess).toHaveBeenCalledWith("proc-1");
    expect(getOutput).toHaveBeenCalled();
    expect(result).toEqual({
      results: [
        {
          status: "running",
          taskId: "bash:proc-1",
          output: "hello",
          elapsed_ms: 5,
          note: undefined,
        },
      ],
    });
  });

  it("task_list includes background bash tasks", async () => {
    using tempDir = new TestTempDir("test-task-list-bash");

    const startTime = Date.parse("2025-01-01T00:00:00.000Z");
    const list = mock(() => [
      {
        id: "proc-1",
        workspaceId: "ws-1",
        status: "running" as const,
        displayName: "My Proc",
        startTime,
      },
    ]);

    const backgroundProcessManager = { list } as unknown as BackgroundProcessManager;

    const taskService = {
      listDescendantAgentTasks: mock(() => []),
      isDescendantAgentTask: mock(() => false),
    } as unknown as TaskService;

    const tool = createTaskListTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "ws-1" }),
      backgroundProcessManager,
      taskService,
    });

    const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(result).toEqual({
      tasks: [
        {
          taskId: "bash:proc-1",
          status: "running",
          parentWorkspaceId: "ws-1",
          title: "My Proc",
          createdAt: new Date(startTime).toISOString(),
          depth: 1,
        },
      ],
    });
  });

  it("task_terminate can terminate bash tasks", async () => {
    using tempDir = new TestTempDir("test-task-terminate-bash");

    const getProcess = mock(() => ({ id: "proc-1", workspaceId: "ws-1" }));
    const terminate = mock(() => ({ success: true as const }));

    const backgroundProcessManager = {
      getProcess,
      terminate,
    } as unknown as BackgroundProcessManager;

    const taskService = {
      terminateDescendantAgentTask: mock(() =>
        Promise.resolve({ success: false, error: "not used" })
      ),
      isDescendantAgentTask: mock(() => false),
    } as unknown as TaskService;

    const tool = createTaskTerminateTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "ws-1" }),
      backgroundProcessManager,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["bash:proc-1"] }, mockToolCallOptions)
    );

    expect(getProcess).toHaveBeenCalledWith("proc-1");
    expect(terminate).toHaveBeenCalledWith("proc-1");
    expect(result).toEqual({
      results: [
        { status: "terminated", taskId: "bash:proc-1", terminatedTaskIds: ["bash:proc-1"] },
      ],
    });
  });
});
