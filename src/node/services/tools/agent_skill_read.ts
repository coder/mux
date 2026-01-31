import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { getBuiltInSkillByName } from "@/node/services/agentSkills/builtInSkillDefinitions";

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
 * Build dynamic agent_skill_read tool description with available skills.
 * Injects the list of available skills directly into the tool description
 * so the model sees them adjacent to the tool call schema.
 */
function buildSkillReadDescription(config: ToolConfiguration): string {
  const baseDescription = TOOL_DEFINITIONS.agent_skill_read.description;
  // Filter out unadvertised skills from the tool description.
  // Unadvertised skills can still be invoked via /skill-name or agent_skill_read.
  const skills = (config.availableSkills ?? []).filter((s) => s.advertise !== false);

  if (skills.length === 0) {
    return baseDescription;
  }

  const MAX_SKILLS = 50;
  const shown = skills.slice(0, MAX_SKILLS);
  const omitted = skills.length - shown.length;

  const skillLines = shown.map(
    (skill) => `- ${skill.name}: ${skill.description} (scope: ${skill.scope})`
  );
  if (omitted > 0) {
    skillLines.push(`(+${omitted} more not shown)`);
  }

  const usageHint = `\nTo read referenced files inside a skill directory:\n- agent_skill_read_file({ name: "<skill-name>", filePath: "references/whatever.txt" })`;

  return `${baseDescription}\n\nAvailable skills:\n${skillLines.join("\n")}${usageHint}`;
}

/**
 * Agent Skill read tool factory.
 * Reads and validates a skill's SKILL.md from project-local or global skills roots.
 */
export const createAgentSkillReadTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: buildSkillReadDescription(config),
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
        // Chat with Mux intentionally has no generic filesystem access. Restrict skill reads to
        // built-in skills (bundled in the app) so users can access help like `mux-docs` without
        // granting access to project/global skills on disk.
        if (config.workspaceId === MUX_HELP_CHAT_WORKSPACE_ID) {
          const builtIn = getBuiltInSkillByName(parsedName.data);
          if (!builtIn) {
            return {
              success: false,
              error: `Only built-in skills are available in Chat with Mux (requested: ${parsedName.data}).`,
            };
          }

          return {
            success: true,
            skill: builtIn,
          };
        }

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
