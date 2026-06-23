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
      workflowAgentOutputSchema: { $ref: "#/defs/legacy" },
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
    expect(inputSchema.jsonSchema).toEqual(outputSchema);
  });

  it("sanitizes provider-facing schema while preserving host validation", async () => {
    using tempDir = new TestTempDir("test-agent-report-tool-sanitized-schema");
    const outputSchema = {
      type: "object",
      required: ["code", "score"],
      properties: {
        code: { type: "string", pattern: "^[A-Z]+$", default: "ABC" },
        score: { type: "number", minimum: 1 },
        notes: { type: "string" },
      },
      additionalProperties: { type: "string" },
      allOf: [{ required: ["notes"] }],
    };
    const tool = createAgentReportTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" }),
      taskService: {
        hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
      } as unknown as TaskService,
      workflowAgentOutputSchema: outputSchema,
    });

    expect(tool.inputSchema).toHaveProperty("jsonSchema");
    const inputSchema = tool.inputSchema as { jsonSchema?: typeof outputSchema };
    expect(inputSchema.jsonSchema?.properties.code).toHaveProperty("pattern", "^[A-Z]+$");
    expect(inputSchema.jsonSchema?.properties.code).not.toHaveProperty("default");
    expect(inputSchema.jsonSchema?.properties.score).toHaveProperty("minimum", 1);
    expect(inputSchema.jsonSchema).toHaveProperty("additionalProperties", false);
    expect(inputSchema.jsonSchema).toHaveProperty("required", ["code", "score", "notes"]);
    expect(inputSchema.jsonSchema?.properties.notes).toHaveProperty("type", "string");
    expect(inputSchema.jsonSchema).not.toHaveProperty("allOf");

    const result: unknown = await Promise.resolve(
      tool.execute!({ code: "lowercase", score: 0, notes: "present" }, mockToolCallOptions)
    );

    expect(result).toEqual({
      success: false,
      message: "Structured output failed schema validation.",
      errors: [
        { path: "$.code", message: 'must match pattern "^[A-Z]+$"' },
        { path: "$.score", message: "must be >= 1" },
      ],
    });
  });

  it("treats strict-provider nulls for optional workflow fields as omitted", async () => {
    using tempDir = new TestTempDir("test-agent-report-tool-optional-null-fields");
    const tool = createAgentReportTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" }),
      taskService: {
        hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
      } as unknown as TaskService,
      workflowAgentOutputSchema: {
        type: "object",
        required: ["code", "nested"],
        properties: {
          code: { type: "string" },
          notes: { type: "string" },
          nullableNote: { type: ["string", "null"] },
          nested: {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string" },
              detail: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          code: "ABC",
          notes: null,
          nullableNote: null,
          nested: { id: "nested-1", detail: null },
        },
        mockToolCallOptions
      )
    );

    expect(result).toEqual({
      success: true,
      message: "Report submitted successfully.",
    });
  });

  it("treats strict-provider nulls inside union branch fields as omitted", async () => {
    using tempDir = new TestTempDir("test-agent-report-tool-union-optional-null-fields");
    const tool = createAgentReportTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" }),
      taskService: {
        hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
      } as unknown as TaskService,
      workflowAgentOutputSchema: {
        type: "object",
        required: ["payload"],
        properties: {
          payload: {
            anyOf: [
              {
                type: "object",
                required: ["id"],
                properties: {
                  id: { type: "string" },
                  note: { type: "string" },
                },
                additionalProperties: false,
              },
            ],
          },
        },
        additionalProperties: false,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ payload: { id: "payload-1", note: null } }, mockToolCallOptions)
    );

    expect(result).toEqual({
      success: true,
      message: "Report submitted successfully.",
    });
  });

  it("preserves nullable values required by a matching union branch", async () => {
    using tempDir = new TestTempDir("test-agent-report-tool-union-required-null-field");
    const tool = createAgentReportTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" }),
      taskService: {
        hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
      } as unknown as TaskService,
      workflowAgentOutputSchema: {
        type: "object",
        required: ["payload"],
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                required: ["kind", "value"],
                properties: {
                  kind: { const: "nullable" },
                  value: { type: ["string", "null"] },
                },
                additionalProperties: false,
              },
              {
                type: "object",
                required: ["kind"],
                properties: {
                  kind: { const: "optional" },
                  value: { type: "string" },
                },
                additionalProperties: false,
              },
            ],
          },
        },
        additionalProperties: false,
      },
    });

    const nullableResult: unknown = await Promise.resolve(
      tool.execute!({ payload: { kind: "nullable", value: null } }, mockToolCallOptions)
    );
    const optionalResult: unknown = await Promise.resolve(
      tool.execute!({ payload: { kind: "optional", value: null } }, mockToolCallOptions)
    );

    expect(nullableResult).toEqual({
      success: true,
      message: "Report submitted successfully.",
    });
    expect(optionalResult).toEqual({
      success: true,
      message: "Report submitted successfully.",
    });
  });

  it("accepts schema-shaped workflow output without markdown wrapper", async () => {
    using tempDir = new TestTempDir("test-agent-report-tool-direct-structured");
    const tool = createAgentReportTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "task-workspace" }),
      taskService: {
        hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
      } as unknown as TaskService,
      workflowAgentOutputSchema: {
        type: "object",
        required: ["claims"],
        properties: { claims: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ claims: ["claim"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      success: true,
      message: "Report submitted successfully.",
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
      tool.execute!({ claims: [1] }, mockToolCallOptions)
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
      tool.execute!({ claims: ["a"] }, mockToolCallOptions)
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
