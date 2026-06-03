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

  test("reads a workflow source through WorkflowService", async () => {
    using tempDir = new TestTempDir("test-workflow-read-tool");
    const readDefinition = mock(async () => ({
      descriptor,
      source: "export default function workflow() { return null; }",
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
      descriptor,
      source: "export default function workflow() { return null; }",
    });
  });
});
