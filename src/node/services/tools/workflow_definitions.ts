import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TOOL_DEFINITIONS,
  WorkflowListToolResultSchema,
  WorkflowReadToolResultSchema,
} from "@/common/utils/tools/toolDefinitions";
import { parseToolResult } from "./toolUtils";

function requireWorkflowService(config: ToolConfiguration, toolName: string) {
  if (!config.workflowService) {
    throw new Error(`${toolName} requires workflowService`);
  }
  return config.workflowService;
}

export const createWorkflowListTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.workflow_list.description,
    inputSchema: TOOL_DEFINITIONS.workflow_list.schema,
    execute: async (): Promise<unknown> => {
      const workflowService = requireWorkflowService(config, "workflow_list");
      const workflows = await workflowService.listDefinitions({
        projectTrusted: config.trusted === true,
      });

      return parseToolResult(WorkflowListToolResultSchema, { workflows }, "workflow_list");
    },
  });
};

export const createWorkflowReadTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.workflow_read.description,
    inputSchema: TOOL_DEFINITIONS.workflow_read.schema,
    execute: async (args): Promise<unknown> => {
      const workflowService = requireWorkflowService(config, "workflow_read");
      const result = await workflowService.readDefinition({
        name: args.name,
        projectTrusted: config.trusted === true,
      });

      return parseToolResult(WorkflowReadToolResultSchema, result, "workflow_read");
    },
  });
};
