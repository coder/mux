import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { WorkflowDefinitionDescriptorSchema } from "@/common/orpc/schemas";
import {
  TOOL_DEFINITIONS,
  WorkflowActionListToolResultSchema,
  WorkflowListToolResultSchema,
  WorkflowReadToolResultSchema,
} from "@/common/utils/tools/toolDefinitions";
import {
  summarizeWorkflowArgs,
  workflowDefinitionMetadataForSource,
} from "@/node/services/workflows/workflowMetadata";
import { parseToolResult } from "./toolUtils";

function requireWorkflowService(config: ToolConfiguration, toolName: string) {
  if (!config.workflowService) {
    throw new Error(`${toolName} requires workflowService`);
  }
  return config.workflowService;
}

function workflowSourceStats(source: string): { chars: number; lines: number } {
  return {
    chars: source.length,
    lines: source.length === 0 ? 0 : source.split(/\r\n|\r|\n/u).length,
  };
}

export const createWorkflowListTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.workflow_list.description,
    inputSchema: TOOL_DEFINITIONS.workflow_list.schema,
    execute: async (): Promise<unknown> => {
      const workflowService = requireWorkflowService(config, "workflow_list");
      const projectTrusted = config.trusted === true;
      const workflows =
        workflowService.listDefinitionsWithMetadata != null
          ? await workflowService.listDefinitionsWithMetadata({ projectTrusted })
          : await workflowService.listDefinitions({ projectTrusted });

      return parseToolResult(WorkflowListToolResultSchema, { workflows }, "workflow_list");
    },
  });
};

export const createWorkflowActionListTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.workflow_action_list.description,
    inputSchema: TOOL_DEFINITIONS.workflow_action_list.schema,
    execute: async (): Promise<unknown> => {
      const workflowService = requireWorkflowService(config, "workflow_action_list");
      if (workflowService.listActions == null) {
        throw new Error("workflow_action_list requires workflowService.listActions");
      }
      const actions = await workflowService.listActions({
        projectTrusted: config.trusted === true,
      });

      return parseToolResult(
        WorkflowActionListToolResultSchema,
        { actions },
        "workflow_action_list"
      );
    },
  });
};

export const createWorkflowReadTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.workflow_read.description,
    inputSchema: TOOL_DEFINITIONS.workflow_read.schema,
    execute: async (args): Promise<unknown> => {
      const workflowService = requireWorkflowService(config, "workflow_read");
      const view = args.view ?? "metadata";
      const result = await workflowService.readDefinition({
        name: args.name,
        projectTrusted: config.trusted === true,
      });
      const descriptor = WorkflowDefinitionDescriptorSchema.parse(result.descriptor);
      const metadata = workflowDefinitionMetadataForSource(result.source, descriptor.description);
      const argsSummary = summarizeWorkflowArgs(metadata);
      const payload = {
        view,
        descriptor,
        metadata,
        ...(argsSummary != null ? { args: argsSummary } : {}),
        sourceStats: workflowSourceStats(result.source),
        ...(view === "source" ? { source: result.source } : {}),
      };

      return parseToolResult(WorkflowReadToolResultSchema, payload, "workflow_read");
    },
  });
};
