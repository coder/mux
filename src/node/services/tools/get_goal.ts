import { tool } from "ai";
import assert from "@/common/utils/assert";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

export const createGetGoalTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.get_goal.description,
    inputSchema: TOOL_DEFINITIONS.get_goal.schema,
    execute: async () => {
      assert(config.workspaceId, "get_goal requires workspaceId");
      assert(config.goalService, "get_goal requires goalService");

      const goal = await config.goalService.getGoal(config.workspaceId);
      return { goal };
    },
  });
};
