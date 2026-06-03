import { describe, it, expect, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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

  it("submits a subagent file-backed report from report.md and structured-output.json", async () => {
    using tempDir = new TestTempDir("test-agent-report-tool-file-backed");
    await fs.writeFile(path.join(tempDir.path, "report.md"), "# Done\n\nFindings.", "utf-8");
    await fs.writeFile(
      path.join(tempDir.path, "structured-output.json"),
      JSON.stringify({ claims: ["durable"] }),
      "utf-8"
    );
    const taskService = {
      hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
    } as unknown as TaskService;
    const tool = createAgentReportTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" }),
      taskService,
      subagentReportFiles: true,
      workflowAgentOutputSchema: {
        type: "object",
        required: ["claims"],
        properties: { claims: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    });

    const inputSchema = tool.inputSchema as { jsonSchema?: unknown };
    expect(inputSchema.jsonSchema).toEqual(
      expect.objectContaining({
        required: ["reportMarkdownPath", "structuredOutputPath", "title"],
      })
    );

    const result: unknown = await Promise.resolve(tool.execute!(undefined, mockToolCallOptions));

    expect(result).toEqual({
      success: true,
      message: "Report submitted successfully.",
      report: {
        reportMarkdown: "# Done\n\nFindings.",
        structuredOutput: { claims: ["durable"] },
      },
    });
  });

  it("submits a subagent file-backed markdown report with empty arguments", async () => {
    using tempDir = new TestTempDir("test-agent-report-tool-file-backed-empty-args");
    await fs.writeFile(path.join(tempDir.path, "report.md"), "# Done", "utf-8");
    const tool = createAgentReportTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" }),
      taskService: {
        hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
      } as unknown as TaskService,
      subagentReportFiles: true,
    });

    const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(result).toEqual({
      success: true,
      message: "Report submitted successfully.",
      report: { reportMarkdown: "# Done" },
    });
  });

  it("rejects file-backed structured output that fails workflow schema validation", async () => {
    using tempDir = new TestTempDir("test-agent-report-tool-file-backed-invalid");
    await fs.writeFile(path.join(tempDir.path, "report.md"), "done", "utf-8");
    await fs.writeFile(
      path.join(tempDir.path, "structured-output.json"),
      '{"claims":[1]}',
      "utf-8"
    );
    const tool = createAgentReportTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" }),
      taskService: {
        hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
      } as unknown as TaskService,
      subagentReportFiles: true,
      workflowAgentOutputSchema: {
        type: "object",
        required: ["claims"],
        properties: { claims: { type: "array", items: { type: "string" } } },
      },
    });

    const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(result).toEqual({
      success: false,
      message: "Structured output failed schema validation.",
      errors: [{ path: "$.claims[0]", message: "Expected string, got number" }],
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
