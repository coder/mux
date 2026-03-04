import { tool } from "ai";

import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import type { SkillsCatalogSearchToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { searchSkillsCatalog, tryParseSource } from "./skillsCatalogFetch";

interface SkillsCatalogSearchToolArgs {
  query: string;
  limit?: number | null;
}

export const createSkillsCatalogSearchTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.skills_catalog_search.description,
    inputSchema: TOOL_DEFINITIONS.skills_catalog_search.schema,
    execute: async ({
      query,
      limit,
    }: SkillsCatalogSearchToolArgs): Promise<SkillsCatalogSearchToolResult> => {
      if (config.workspaceId !== MUX_HELP_CHAT_WORKSPACE_ID) {
        return {
          success: false,
          error: "skills_catalog_search is only available in the Chat with Mux system workspace",
        };
      }

      try {
        const response = await searchSkillsCatalog(query, limit ?? 10);

        const skills = response.skills.flatMap((skill) => {
          const parsed = tryParseSource(skill.source);
          if (!parsed) return [];
          return [
            {
              skillId: skill.skillId,
              name: skill.name,
              owner: parsed.owner,
              repo: parsed.repo,
              installs: skill.installs,
              url: `https://skills.sh/skill/${skill.skillId}`,
            },
          ];
        });

        return {
          success: true,
          query: response.query,
          searchType: response.searchType,
          count: skills.length,
          skills,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
};
