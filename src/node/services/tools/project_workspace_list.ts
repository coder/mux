import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  ProjectWorkspaceListToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";
import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";

export const createProjectWorkspaceListTool: ToolFactory = (config: ToolConfiguration) =>
  tool({
    description: TOOL_DEFINITIONS.project_workspace_list.description,
    inputSchema: TOOL_DEFINITIONS.project_workspace_list.schema,
    execute: async (args): Promise<unknown> => {
      if (config.projectChat !== true) {
        throw new Error("project_workspace_list is only available in Project Chat");
      }
      const ownerWorkspaceId = requireWorkspaceId(config, "project_workspace_list");
      const taskService = requireTaskService(config, "project_workspace_list");
      const result = await taskService.listProjectWorkspaces(ownerWorkspaceId, {
        // Strict providers represent omitted optional tool inputs as null; preserve the true default.
        includeArchived: args.include_archived ?? true,
        ...(args.project_path != null ? { projectPath: args.project_path } : {}),
      });
      if (!result.success) {
        throw new Error(result.error);
      }
      return parseToolResult(
        ProjectWorkspaceListToolResultSchema,
        result.data,
        "project_workspace_list"
      );
    },
  });
