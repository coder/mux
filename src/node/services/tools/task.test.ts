import { describe, it, expect, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import type { TaskCreatedEvent } from "@/common/types/stream";

import { createTaskTool } from "./task";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import { Ok, Err } from "@/common/types/result";
import { ForegroundWaitBackgroundedError, type TaskService } from "@/node/services/taskService";

// Mock ToolCallOptions for testing
const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

function expectQueuedOrRunningTaskToolResult(
  result: unknown,
  expected: { status: "queued" | "running"; taskId: string }
): void {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");
  expect(result).not.toBeNull();

  const obj = result as Record<string, unknown>;
  expect(obj.status).toBe(expected.status);
  expect(obj.taskId).toBe(expected.taskId);

  const note = obj.note;
  expect(typeof note).toBe("string");
  if (typeof note === "string") {
    expect(note).toContain("task_await");
  }
}

describe("task tool", () => {
  it("should return immediately when run_in_background is true", async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      muxEnv: { MUX_MODEL_STRING: "openai:gpt-4o-mini", MUX_THINKING_LEVEL: "high" },
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { subagent_type: "explore", prompt: "do it", title: "Child task", run_in_background: true },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalled();
    expect(waitForAgentReport).not.toHaveBeenCalled();
    expectQueuedOrRunningTaskToolResult(result, { status: "queued", taskId: "child-task" });
  });

  it("should allow sub-agent workspaces to spawn nested tasks", async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "child-workspace" });

    const create = mock(() =>
      Ok({ taskId: "grandchild-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      enableAgentReport: true,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "do it",
          title: "Grandchild task",
          run_in_background: true,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        parentWorkspaceId: "child-workspace",
        kind: "agent",
        agentId: "explore",
        agentType: "explore",
      })
    );
    expectQueuedOrRunningTaskToolResult(result, { status: "queued", taskId: "grandchild-task" });
  });

  it("should block and return report when run_in_background is false", async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const events: TaskCreatedEvent[] = [];
    let didEmitTaskCreated = false;

    const create = mock(() =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(() => {
      // The main thing we care about: emit the UI-only taskId before we block waiting for the report.
      expect(didEmitTaskCreated).toBe(true);
      return Promise.resolve({
        reportMarkdown: "Hello from child",
        title: "Result",
      });
    });
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      emitChatEvent: (event) => {
        if (event.type === "task-created") {
          didEmitTaskCreated = true;
          events.push(event);
        }
      },
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "do it",
          title: "Child task",
          run_in_background: false,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalled();
    expect(waitForAgentReport).toHaveBeenCalledWith("child-task", expect.any(Object));

    expect(events).toHaveLength(1);
    const taskCreated = events[0];
    if (!taskCreated) {
      throw new Error("Expected a task-created event");
    }

    expect(taskCreated.type).toBe("task-created");

    const parentWorkspaceId = baseConfig.workspaceId;
    if (!parentWorkspaceId) {
      throw new Error("Expected baseConfig.workspaceId to be set");
    }
    expect(taskCreated.workspaceId).toBe(parentWorkspaceId);
    expect(taskCreated.toolCallId).toBe(mockToolCallOptions.toolCallId);
    expect(taskCreated.taskId).toBe("child-task");
    expect(typeof taskCreated.timestamp).toBe("number");
    expect(result).toEqual({
      status: "completed",
      taskId: "child-task",
      reportMarkdown: "Hello from child",
      title: "Result",
      agentId: "explore",
      agentType: "explore",
    });
  });

  it("should return taskId (with note) if foreground wait times out", async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() =>
      Promise.reject(new Error("Timed out waiting for agent_report"))
    );
    const getAgentTaskStatus = mock(() => "running" as const);
    const taskService = {
      create,
      waitForAgentReport,
      getAgentTaskStatus,
    } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "do it",
          title: "Child task",
          run_in_background: false,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalled();
    expect(waitForAgentReport).toHaveBeenCalledWith("child-task", expect.any(Object));
    expect(getAgentTaskStatus).toHaveBeenCalledWith("child-task");
    expectQueuedOrRunningTaskToolResult(result, { status: "running", taskId: "child-task" });
  });

  it("should return background result when foreground wait is backgrounded", async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() => Promise.reject(new ForegroundWaitBackgroundedError()));
    const getAgentTaskStatus = mock(() => "running" as const);
    const taskService = {
      create,
      waitForAgentReport,
      getAgentTaskStatus,
    } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "do it",
          title: "Child task",
          run_in_background: false,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalled();
    expect(waitForAgentReport).toHaveBeenCalledWith(
      "child-task",
      expect.objectContaining({ backgroundOnMessageQueued: true })
    );
    expect(getAgentTaskStatus).toHaveBeenCalledWith("child-task");
    expectQueuedOrRunningTaskToolResult(result, { status: "running", taskId: "child-task" });
    expect((result as { note?: string }).note).toContain("task_await");
  });

  it("should throw when TaskService.create fails (e.g., depth limit)", async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() => Err("maxTaskNestingDepth exceeded"));
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!(
          { subagent_type: "explore", prompt: "do it", title: "Child task" },
          mockToolCallOptions
        )
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/maxTaskNestingDepth/i);
    }
  });

  it('should reject spawning "exec" tasks while in plan agent', async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(() =>
      Promise.resolve({
        reportMarkdown: "Hello from child",
        title: "Result",
      })
    );
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      planFileOnly: true,
      taskService,
    });

    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!(
          { subagent_type: "exec", prompt: "do it", title: "Child task" },
          mockToolCallOptions
        )
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/plan agent/i);
    }
    expect(create).not.toHaveBeenCalled();
    expect(waitForAgentReport).not.toHaveBeenCalled();
  });
});
