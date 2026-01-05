import { tool } from "ai";

import type { AgentSkillReadToolResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { SkillNameSchema } from "@/common/orpc/schemas";
import { readAgentSkill } from "@/node/services/agentSkills/agentSkillsService";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Agent Skill read tool factory.
 * Reads and validates a skill's SKILL.md from project-local or global skills roots.
 */
export const createAgentSkillReadTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.agent_skill_read.description,
    inputSchema: TOOL_DEFINITIONS.agent_skill_read.schema,
    execute: async ({ name }): Promise<AgentSkillReadToolResult> => {
      const workspacePath = config.cwd;
      if (!workspacePath) {
        return {
          success: false,
          error: "Tool misconfigured: cwd is required.",
        };
      }

      // Defensive: validate again even though inputSchema should guarantee shape.
      const parsedName = SkillNameSchema.safeParse(name);
      if (!parsedName.success) {
        return {
          success: false,
          error: parsedName.error.message,
        };
      }

      try {
        const resolved = await readAgentSkill(config.runtime, workspacePath, parsedName.data);
        return {
          success: true,
          skill: resolved.package,
        };
      } catch (error) {
        return {
          success: false,
          error: formatError(error),
        };
      }
    },
  });
};
