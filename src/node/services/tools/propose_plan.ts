import { tool } from "ai";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

/**
 * Propose plan tool factory for AI assistant
 * Creates a tool that allows the AI to propose a plan for approval before execution
 * @param config Required configuration (not used for this tool, but required by interface)
 */
export const createProposePlanTool: ToolFactory = () => {
  return tool({
    description: TOOL_DEFINITIONS.propose_plan.description,
    inputSchema: TOOL_DEFINITIONS.propose_plan.schema,
    execute: ({ title, plan }) => {
      // Tool execution is a no-op on the backend
      // The plan is displayed in the frontend and user decides whether to approve
      return Promise.resolve({
        success: true,
        title,
        plan,
        message: "Plan proposed. Waiting for user approval.",
      });
    },
  });
};
