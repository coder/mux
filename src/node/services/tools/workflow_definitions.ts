import { tool } from "ai";

import { WorkflowDefinitionDescriptorSchema } from "@/common/orpc/schemas";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import assert from "@/common/utils/assert";
import {
  TOOL_DEFINITIONS,
  WorkflowListToolResultSchema,
  WorkflowReadToolResultSchema,
} from "@/common/utils/tools/toolDefinitions";
import { summarizeWorkflowDefinitionSource } from "@/node/services/workflows/workflowMetadata";
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
      const projectTrusted = config.trusted === true;
      const workflows =
        workflowService.listDefinitionsWithMetadata != null
          ? await workflowService.listDefinitionsWithMetadata({ projectTrusted })
          : await workflowService.listDefinitions({ projectTrusted });

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
      const view = args.view ?? "metadata";
      const result = await workflowService.readDefinition({
        name: args.name,
        projectTrusted: config.trusted === true,
      });
      const descriptor = WorkflowDefinitionDescriptorSchema.parse(result.descriptor);
      const fallbackSummary =
        result.metadata == null || result.sourceStats == null
          ? summarizeWorkflowDefinitionSource(result.source, descriptor.description).metadataSummary
          : null;
      const sourceStats = result.sourceStats ?? fallbackSummary?.sourceStats;
      assert(sourceStats != null, "Workflow read source stats are required");
      const payload = {
        view,
        descriptor,
        metadata: result.metadata ?? fallbackSummary?.metadata ?? null,
        ...(result.args != null || fallbackSummary?.args != null
          ? { args: result.args ?? fallbackSummary?.args }
          : {}),
        sourceStats,
        ...(view === "source" ? { source: result.source } : {}),
      };

      return parseToolResult(WorkflowReadToolResultSchema, payload, "workflow_read");
    },
  });
};
