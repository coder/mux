import { tool } from "ai";
import assert from "@/common/utils/assert";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

export const createCompleteGoalTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.complete_goal.description,
    inputSchema: TOOL_DEFINITIONS.complete_goal.schema,
    execute: async ({ summary, goalId }) => {
      assert(config.workspaceId, "complete_goal requires workspaceId");
      assert(config.goalService, "complete_goal requires goalService");
      assert(summary.trim().length > 0, "complete_goal requires a non-empty summary");

      const result = await config.goalService.setGoal({
        workspaceId: config.workspaceId,
        status: "complete",
        completionSummary: summary,
        initiator: "model",
        // Forward the model-provided optimistic-concurrency token so a goal
        // that was cleared or replaced mid-stream surfaces as a typed
        // `goal_conflict` from the Result branch instead of throwing a
        // confusing "Goal objective is required." error from
        // setGoalImmediately when `current === null`
        // (Coder-agents-review P3 DEREM-20).
        ...(goalId != null ? { expectedGoalId: goalId } : {}),
      });
      if (!result.success) {
        throw new Error(`Failed to complete goal: ${result.error.type}`);
      }

      return { goal: result.data };
    },
  });
};
