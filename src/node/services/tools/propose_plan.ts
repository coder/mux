import { tool } from "ai";
import { z } from "zod";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { readFileString } from "@/node/utils/runtime/helpers";
import { RuntimeError } from "@/node/runtime/Runtime";

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
      const planPath = config.planFilePath;

      if (!planPath) {
        return {
          success: false as const,
          error: "No plan file path configured. Are you in plan mode?",
        };
      }

      // Read plan file using workspace runtime (works for both local and SSH)
      let planContent: string;
      try {
        planContent = await readFileString(config.runtime, planPath);
      } catch (err) {
        if (err instanceof RuntimeError) {
          return {
            success: false as const,
            error: `No plan file found at ${planPath}. Please write your plan to this file before calling propose_plan.`,
          };
        }
        throw err;
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
          const fileStat = await config.runtime.stat(planPath);
          config.recordFileState(planPath, {
            content: planContent,
            timestamp: fileStat.modifiedTime.getTime(),
          });
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
