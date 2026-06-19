/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await */
import { describe, expect, mock, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import { createWorkflowListTool, createWorkflowReadTool } from "./workflow_definitions";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

const descriptor = {
  name: "deep-research",
  description: "Deep research",
  scope: "built-in" as const,
  executable: true,
};

const workflowSource = `const s = mux.schema;
export const metadata = {
  description: "Deep research",
  argsSchema: s.object({
    topic: s.optional(s.string({ positional: true })),
    mode: s.optional(s.enum(["quick", "smart", "fast"], { aliases: ["--mode"] })),
  }),
};
export default function workflow() { return null; }
`;

const metadata = {
  description: "Deep research",
  argsSchema: {
    type: "object",
    required: [],
    properties: {
      topic: { type: "string", positional: true },
      mode: { type: "string", enum: ["quick", "smart", "fast"], aliases: ["--mode"] },
    },
  },
};

const sourceStats = {
  chars: workflowSource.length,
  lines: workflowSource.split(/\r\n|\r|\n/u).length,
};

const compactArgs = [
  {
    name: "topic",
    types: ["string"],
    required: false,
    positional: true,
  },
  {
    name: "mode",
    types: ["string"],
    required: false,
    aliases: ["--mode"],
    enum: ["quick", "smart", "fast"],
  },
];

describe("workflow definition tools", () => {
  test("lists available workflows through WorkflowService", async () => {
    using tempDir = new TestTempDir("test-workflow-list-tool");
    const listDefinitions = mock(async () => [descriptor]);
    const tool = createWorkflowListTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        listDefinitions,
        readDefinition: mock(async () => ({
          descriptor,
          source: "export default function workflow() { return null; }",
        })),
        startNamedWorkflow: mock(async () => ({
          runId: "wfr_1",
          status: "completed" as const,
          result: null,
        })),
      },
    });

    const result = await tool.execute!({}, mockToolCallOptions);

    expect(listDefinitions).toHaveBeenCalledWith({ projectTrusted: true });
    expect(result).toEqual({ workflows: [descriptor] });
  });

  test("prefers compact workflow argument metadata when available", async () => {
    using tempDir = new TestTempDir("test-workflow-list-tool-metadata");
    const listDefinitions = mock(async () => [descriptor]);
    const listDefinitionsWithMetadata = mock(async () => [{ ...descriptor, args: compactArgs }]);
    const tool = createWorkflowListTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        listDefinitions,
        listDefinitionsWithMetadata,
        readDefinition: mock(async () => ({
          descriptor,
          source: workflowSource,
        })),
        startNamedWorkflow: mock(async () => ({
          runId: "wfr_1",
          status: "completed" as const,
          result: null,
        })),
      },
    });

    const result = await tool.execute!({}, mockToolCallOptions);

    expect(listDefinitionsWithMetadata).toHaveBeenCalledWith({ projectTrusted: true });
    expect(listDefinitions).not.toHaveBeenCalled();
    expect(result).toEqual({ workflows: [{ ...descriptor, args: compactArgs }] });
  });

  test("reads workflow metadata without source by default", async () => {
    using tempDir = new TestTempDir("test-workflow-read-tool");
    const readDefinition = mock(async () => ({
      descriptor,
      source: workflowSource,
      metadata,
      args: compactArgs,
      sourceStats,
    }));
    const tool = createWorkflowReadTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: false,
      workflowService: {
        listDefinitions: mock(async () => []),
        readDefinition,
        startNamedWorkflow: mock(async () => ({
          runId: "wfr_1",
          status: "completed" as const,
          result: null,
        })),
      },
    });

    const result = await tool.execute!({ name: "deep-research" }, mockToolCallOptions);

    expect(readDefinition).toHaveBeenCalledWith({ name: "deep-research", projectTrusted: false });
    expect(result).toEqual({
      view: "metadata",
      descriptor,
      metadata,
      args: compactArgs,
      sourceStats,
    });
  });

  test("synthesizes workflow_read metadata for minimal service results", async () => {
    using tempDir = new TestTempDir("test-workflow-read-tool-fallback-metadata");
    const tool = createWorkflowReadTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: false,
      workflowService: {
        listDefinitions: mock(async () => []),
        readDefinition: mock(async () => ({ descriptor, source: workflowSource })),
        startNamedWorkflow: mock(async () => ({
          runId: "wfr_1",
          status: "completed" as const,
          result: null,
        })),
      },
    });

    const result = await tool.execute!({ name: "deep-research" }, mockToolCallOptions);

    expect(result).toEqual({
      view: "metadata",
      descriptor,
      metadata,
      args: compactArgs,
      sourceStats,
    });
  });

  test("returns workflow source only when requested", async () => {
    using tempDir = new TestTempDir("test-workflow-read-source-tool");
    const tool = createWorkflowReadTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: false,
      workflowService: {
        listDefinitions: mock(async () => []),
        readDefinition: mock(async () => ({
          descriptor,
          source: workflowSource,
          metadata,
          args: compactArgs,
          sourceStats,
        })),
        startNamedWorkflow: mock(async () => ({
          runId: "wfr_1",
          status: "completed" as const,
          result: null,
        })),
      },
    });

    const result = await tool.execute!(
      { name: "deep-research", view: "source" },
      mockToolCallOptions
    );

    expect(result).toMatchObject({
      view: "source",
      descriptor,
      source: workflowSource,
    });
  });
});
