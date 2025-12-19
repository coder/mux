import { describe, it, expect, mock } from "bun:test";
import type { ToolCallOptions } from "ai";

import { createAgentReportTool } from "./agent_report";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { TaskService } from "@/node/services/taskService";

const mockToolCallOptions: ToolCallOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

describe("agent_report tool", () => {
  it("throws when the task has active descendants", async () => {
    using tempDir = new TestTempDir("test-agent-report-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" });

    const taskService = {
      hasActiveDescendantAgentTasksForWorkspace: mock(() => true),
    } as unknown as TaskService;

    const tool = createAgentReportTool({ ...baseConfig, taskService });

    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!({ reportMarkdown: "done", title: "t" }, mockToolCallOptions)
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/still has running\/queued/i);
    }
  });

  it("returns success when the task has no active descendants", async () => {
    using tempDir = new TestTempDir("test-agent-report-tool-ok");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" });

    const taskService = {
      hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
    } as unknown as TaskService;

    const tool = createAgentReportTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ reportMarkdown: "done", title: "t" }, mockToolCallOptions)
    );

    expect(result).toEqual({ success: true });
  });
});
