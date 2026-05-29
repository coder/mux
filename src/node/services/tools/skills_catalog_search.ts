import { tool } from "ai";

import type { SkillsCatalogSearchToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { searchSkillsCatalog, tryParseSource } from "./skillsCatalogFetch";

interface SkillsCatalogSearchToolArgs {
  query: string;
  limit?: number | null;
}

export const createSkillsCatalogSearchTool: ToolFactory = (_config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.skills_catalog_search.description,
    inputSchema: TOOL_DEFINITIONS.skills_catalog_search.schema,
    execute: async ({
      query,
      limit,
    }: SkillsCatalogSearchToolArgs): Promise<SkillsCatalogSearchToolResult> => {
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
