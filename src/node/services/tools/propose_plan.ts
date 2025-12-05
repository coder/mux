import { stat } from "fs/promises";
import { tool } from "ai";
import { z } from "zod";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getPlanFilePath, readPlanFile } from "@/common/utils/planStorage";

// Schema for propose_plan - empty object (no input parameters)
// Defined locally to avoid type inference issues with `as const` in TOOL_DEFINITIONS
const proposePlanSchema = z.object({});

/**
 * Propose plan tool factory for AI assistant.
 * The tool reads the plan from the plan file the agent wrote to.
 * If the plan file doesn't exist, it returns an error instructing
 * the agent to write the plan first.
 */
export const createProposePlanTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.propose_plan.description,
    inputSchema: proposePlanSchema,
    execute: async () => {
      const workspaceId = config.workspaceId;

      if (!workspaceId) {
        return {
          success: false as const,
          error: "No workspace ID available. Cannot determine plan file location.",
        };
      }

      const planPath = getPlanFilePath(workspaceId);
      const planContent = readPlanFile(workspaceId);

      if (planContent === null) {
        return {
          success: false as const,
          error: `No plan file found at ${planPath}. Please write your plan to this file before calling propose_plan.`,
        };
      }

      if (planContent === "") {
        return {
          success: false as const,
          error: `Plan file at ${planPath} is empty. Please write your plan content before calling propose_plan.`,
        };
      }

      // Record file state for external edit detection
      if (config.recordFileState) {
        try {
          const mtime = (await stat(planPath)).mtimeMs;
          config.recordFileState(planPath, { content: planContent, timestamp: mtime });
        } catch {
          // File stat failed, skip recording (shouldn't happen since we just read it)
        }
      }

      return {
        success: true as const,
        planPath,
        planContent,
        message: "Plan proposed. Waiting for user approval.",
      };
    },
  });
};
