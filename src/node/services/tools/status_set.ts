import { tool } from "ai";
import type { ToolFactory, ToolConfiguration } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { StatusSetToolArgs, StatusSetToolResult } from "@/common/types/tools";

/**
 * status_set tool (script-based)
 *
 * Registers a status script that mux executes (optionally repeatedly) to keep the workspace status fresh.
 *
 * Implementation note:
 * - The tool itself is intentionally thin.
 * - Persistence + rehydration is owned by StatusSetService (so status survives restarts/reloads).
 */
export const createStatusSetTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.status_set.description,
    inputSchema: TOOL_DEFINITIONS.status_set.schema,
    execute: async (args: StatusSetToolArgs): Promise<StatusSetToolResult> => {
      const workspaceId = config.workspaceId;
      if (!workspaceId) {
        return { success: false, error: "status_set requires workspaceId" };
      }

      if (!config.statusSetService) {
        return { success: false, error: "status_set requires statusSetService" };
      }

      const env = {
        ...(config.muxEnv ?? {}),
        ...(config.secrets ?? {}),
      };

      const result = await config.statusSetService.setFromToolCall({
        workspaceId,
        toolArgs: args,
        runtime: config.runtime,
        cwd: config.cwd,
        env,
      });

      if (!result.success) {
        return { success: false, error: result.error };
      }

      return { success: true };
    },
  });
};
