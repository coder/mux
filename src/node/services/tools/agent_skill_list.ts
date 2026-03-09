import { tool } from "ai";

import type { AgentSkillListToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { discoverAgentSkills } from "@/node/services/agentSkills/agentSkillsService";

interface AgentSkillListToolArgs {
  includeUnadvertised?: boolean | null;
}

export const createAgentSkillListTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.agent_skill_list.description,
    inputSchema: TOOL_DEFINITIONS.agent_skill_list.schema,
    execute: async ({
      includeUnadvertised,
    }: AgentSkillListToolArgs): Promise<AgentSkillListToolResult> => {
      if (!config.cwd || config.cwd.trim().length === 0) {
        return {
          success: false,
          error: "Tool misconfigured: cwd is required.",
        };
      }

      try {
        const skills = await discoverAgentSkills(config.runtime, config.cwd);

        return {
          success: true,
          skills:
            includeUnadvertised === true
              ? skills
              : skills.filter((skill) => skill.advertise !== false),
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to list available skills: ${getErrorMessage(error)}`,
        };
      }
    },
  });
};
