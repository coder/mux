import { describe, it, expect, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { createAgentReportTool } from "./agent_report";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { TaskService } from "@/node/services/taskService";
import { StreamEditTracker } from "@/node/services/streamGuardrails/StreamEditTracker";
import { StreamVerificationTracker } from "@/node/services/streamGuardrails/StreamVerificationTracker";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};
function createTaskService(hasActiveDescendants: boolean): TaskService {
  return {
    hasActiveDescendantAgentTasksForWorkspace: mock(() => hasActiveDescendants),
  } as unknown as TaskService;
}

describe("agent_report tool", () => {
  it("throws when the task has active descendants", async () => {
    using tempDir = new TestTempDir("test-agent-report-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" });

    const taskService = createTaskService(true);

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

    const taskService = createTaskService(false);

    const tool = createAgentReportTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ reportMarkdown: "done", title: "t" }, mockToolCallOptions)
    );

    expect(result).toEqual({
      success: true,
      message: "Report submitted successfully.",
    });
  });

  it("allows report when trackers are present but no edits occurred", async () => {
    using tempDir = new TestTempDir("test-agent-report-no-edits");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" });

    const editTracker = new StreamEditTracker();
    const verificationTracker = new StreamVerificationTracker();
    const tool = createAgentReportTool({
      ...baseConfig,
      taskService: createTaskService(false),
      editTracker,
      verificationTracker,
    });

    const result = (await Promise.resolve(
      tool.execute!({ reportMarkdown: "done", title: "t" }, mockToolCallOptions)
    )) as unknown;

    expect(result).toEqual({
      success: true,
      message: "Report submitted successfully.",
    });
  });

  it("rejects first report when edits occurred but no validation was attempted", async () => {
    using tempDir = new TestTempDir("test-agent-report-missing-validation");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" });

    const editTracker = new StreamEditTracker();
    editTracker.recordEdit("/tmp/file.ts");
    const verificationTracker = new StreamVerificationTracker();

    const tool = createAgentReportTool({
      ...baseConfig,
      taskService: createTaskService(false),
      editTracker,
      verificationTracker,
    });

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
      expect(caught.message).toMatch(/no validation commands detected/i);
    }
    expect(verificationTracker.hasBeenNudged()).toBe(true);
  });

  it("allows a second report without validation as an explicit escape hatch", async () => {
    using tempDir = new TestTempDir("test-agent-report-escape-hatch");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" });

    const editTracker = new StreamEditTracker();
    editTracker.recordEdit("/tmp/file.ts");
    const verificationTracker = new StreamVerificationTracker();

    const tool = createAgentReportTool({
      ...baseConfig,
      taskService: createTaskService(false),
      editTracker,
      verificationTracker,
    });

    let firstError: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!({ reportMarkdown: "done", title: "t" }, mockToolCallOptions)
      );
    } catch (error: unknown) {
      firstError = error;
    }

    expect(firstError).toBeInstanceOf(Error);
    if (firstError instanceof Error) {
      expect(firstError.message).toMatch(/no validation commands detected/i);
    }

    const secondResult: unknown = await Promise.resolve(
      tool.execute!({ reportMarkdown: "done", title: "t" }, mockToolCallOptions)
    );

    expect(secondResult).toEqual({
      success: true,
      message: "Report submitted successfully.",
    });
  });

  it("allows report after validation attempt", async () => {
    using tempDir = new TestTempDir("test-agent-report-validated");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" });

    const editTracker = new StreamEditTracker();
    editTracker.recordEdit("/tmp/file.ts");
    const verificationTracker = new StreamVerificationTracker();
    verificationTracker.markValidationAttempt();

    const tool = createAgentReportTool({
      ...baseConfig,
      taskService: createTaskService(false),
      editTracker,
      verificationTracker,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ reportMarkdown: "done", title: "t" }, mockToolCallOptions)
    );

    expect(result).toEqual({
      success: true,
      message: "Report submitted successfully.",
    });
  });
});
