import { describe, it, expect, mock } from "bun:test";
import type { ToolCallOptions } from "ai";

import { createTaskTool } from "./task";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import { Ok, Err } from "@/common/types/result";
import type { TaskService } from "@/node/services/taskService";

// Mock ToolCallOptions for testing
const mockToolCallOptions: ToolCallOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

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
        { subagent_type: "explore", prompt: "do it", run_in_background: true },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalled();
    expect(waitForAgentReport).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "queued", taskId: "child-task" });
  });

  it("should block and return report when run_in_background is false", async () => {
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
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { subagent_type: "explore", prompt: "do it", run_in_background: false },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalled();
    expect(waitForAgentReport).toHaveBeenCalledWith("child-task", expect.any(Object));
    expect(result).toEqual({
      status: "completed",
      taskId: "child-task",
      reportMarkdown: "Hello from child",
      title: "Result",
      agentType: "explore",
    });
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
        tool.execute!({ subagent_type: "explore", prompt: "do it" }, mockToolCallOptions)
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/maxTaskNestingDepth/i);
    }
  });

  it('should reject spawning "exec" tasks while in plan mode', async () => {
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
      mode: "plan",
      taskService,
    });

    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!({ subagent_type: "exec", prompt: "do it" }, mockToolCallOptions)
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/plan mode/i);
    }
    expect(create).not.toHaveBeenCalled();
    expect(waitForAgentReport).not.toHaveBeenCalled();
  });
});
