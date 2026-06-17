/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await */
import { describe, expect, mock, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import {
  createWorkflowActionListTool,
  createWorkflowListTool,
  createWorkflowReadTool,
} from "./workflow_definitions";
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
    quick: s.optional(s.boolean({ default: false, aliases: ["--quick"] })),
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
      quick: { type: "boolean", default: false, aliases: ["--quick"] },
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
    name: "quick",
    types: ["boolean"],
    required: false,
    aliases: ["--quick"],
    default: false,
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

  test("lists available workflow actions through WorkflowService", async () => {
    using tempDir = new TestTempDir("test-workflow-action-list-tool");
    const actionDescriptor = {
      name: "git.status",
      scope: "built-in" as const,
      sourcePath: "/__mux_builtin_workflow_actions__/git/status.js",
      executable: true as const,
      metadata: {
        version: 1,
        description: "Return git status",
        effect: "read" as const,
        outputSchema: { type: "object" },
      },
      hasReconcile: false,
    };
    const listActions = mock(async () => [actionDescriptor]);
    const tool = createWorkflowActionListTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        listDefinitions: mock(async () => []),
        readDefinition: mock(async () => ({
          descriptor,
          source: "export default function workflow() { return null; }",
        })),
        listActions,
        startNamedWorkflow: mock(async () => ({
          runId: "wfr_1",
          status: "completed" as const,
          result: null,
        })),
      },
    });

    const result = await tool.execute!({}, mockToolCallOptions);

    expect(listActions).toHaveBeenCalledWith({ projectTrusted: true });
    expect(result).toEqual({ actions: [actionDescriptor] });
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
