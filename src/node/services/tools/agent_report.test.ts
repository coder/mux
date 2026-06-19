import { describe, it, expect, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { createAgentReportTool } from "./agent_report";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { TaskService } from "@/node/services/taskService";

const mockToolCallOptions: ToolExecutionOptions = {
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

  it("omits structuredOutput from non-workflow agent_report input", async () => {
    using tempDir = new TestTempDir("test-agent-report-tool-no-structured-schema");
    const taskService = {
      hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
    } as unknown as TaskService;
    const tool = createAgentReportTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" }),
      taskService,
    });

    const inputSchema = tool.inputSchema as { safeParse(value: unknown): { success: boolean } };
    expect(inputSchema.safeParse({ reportMarkdown: "done", title: null }).success).toBe(true);
    expect(
      inputSchema.safeParse({
        reportMarkdown: "done",
        structuredOutput: { claims: [] },
        title: null,
      }).success
    ).toBe(false);

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { reportMarkdown: "done", structuredOutput: { claims: [] }, title: null },
        mockToolCallOptions
      )
    );
    expect(result).toEqual({
      success: false,
      message: "Report arguments failed validation.",
      errors: [{ path: "$", message: 'Unrecognized key: "structuredOutput"' }],
    });
  });

  it("treats legacy invalid workflow output schemas as markdown-only", async () => {
    using tempDir = new TestTempDir("test-agent-report-tool-legacy-invalid-schema");
    const taskService = {
      hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
    } as unknown as TaskService;
    const tool = createAgentReportTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" }),
      taskService,
      workflowAgentOutputSchema: { type: "object", description: "pre-upgrade schema" },
      allowLegacyInvalidWorkflowAgentOutputSchema: true,
    });

    const inputSchema = tool.inputSchema as { safeParse(value: unknown): { success: boolean } };
    expect(inputSchema.safeParse({ reportMarkdown: "done", title: null }).success).toBe(true);
    expect(
      inputSchema.safeParse({ reportMarkdown: "done", structuredOutput: {}, title: null }).success
    ).toBe(false);

    const result: unknown = await Promise.resolve(
      tool.execute!({ reportMarkdown: "done", title: null }, mockToolCallOptions)
    );
    expect(result).toEqual({
      success: true,
      message: "Report submitted successfully.",
    });
  });

  it("exposes workflow output schema directly in inline agent_report input", () => {
    using tempDir = new TestTempDir("test-agent-report-tool-schema");
    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    };
    const tool = createAgentReportTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" }),
      taskService: {
        hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
      } as unknown as TaskService,
      workflowAgentOutputSchema: outputSchema,
    });

    const inputSchema = tool.inputSchema as { jsonSchema?: unknown };
    expect(inputSchema.jsonSchema).toEqual({
      type: "object",
      properties: {
        reportMarkdown: { type: "string", minLength: 1 },
        structuredOutput: outputSchema,
        title: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["reportMarkdown", "structuredOutput", "title"],
      additionalProperties: false,
    });
  });

  it("returns validation failure without finalizing when structured output does not match workflow schema", async () => {
    using tempDir = new TestTempDir("test-agent-report-tool-structured-invalid");
    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: "task-workspace",
    });

    const taskService = {
      hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
    } as unknown as TaskService;

    const tool = createAgentReportTool({
      ...baseConfig,
      taskService,
      workflowAgentOutputSchema: {
        type: "object",
        required: ["claims"],
        properties: { claims: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { reportMarkdown: "done", structuredOutput: { claims: [1] } },
        mockToolCallOptions
      )
    );

    expect(result).toEqual({
      success: false,
      message: "Structured output failed schema validation.",
      errors: [{ path: "$.claims[0]", message: "Expected string, got number" }],
    });
  });

  it("returns success when structured output satisfies workflow schema", async () => {
    using tempDir = new TestTempDir("test-agent-report-tool-structured-ok");
    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: "task-workspace",
    });

    const taskService = {
      hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
    } as unknown as TaskService;

    const tool = createAgentReportTool({
      ...baseConfig,
      taskService,
      workflowAgentOutputSchema: {
        type: "object",
        required: ["claims"],
        properties: { claims: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { reportMarkdown: "done", structuredOutput: { claims: ["a"] } },
        mockToolCallOptions
      )
    );

    expect(result).toEqual({
      success: true,
      message: "Report submitted successfully.",
    });
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

    expect(result).toEqual({
      success: true,
      message: "Report submitted successfully.",
    });
  });
});
