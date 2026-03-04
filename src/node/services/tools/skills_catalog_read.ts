import { tool } from "ai";

import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import type { SkillsCatalogReadToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { fetchSkillContent } from "./skillsCatalogFetch";

interface SkillsCatalogReadToolArgs {
  owner: string;
  repo: string;
  skillId: string;
}

export const createSkillsCatalogReadTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.skills_catalog_read.description,
    inputSchema: TOOL_DEFINITIONS.skills_catalog_read.schema,
    execute: async ({
      owner,
      repo,
      skillId,
    }: SkillsCatalogReadToolArgs): Promise<SkillsCatalogReadToolResult> => {
      if (config.workspaceId !== MUX_HELP_CHAT_WORKSPACE_ID) {
        return {
          success: false,
          error: "skills_catalog_read is only available in the Chat with Mux system workspace",
        };
      }

      try {
        const fetched = await fetchSkillContent(owner, repo, skillId);

        const parsed = parseSkillMarkdown({
          content: fetched.content,
          byteSize: Buffer.byteLength(fetched.content, "utf-8"),
          // Don't pass directoryName — catalog skills may have mismatched directory/frontmatter names.
        });

        return {
          success: true,
          skillId,
          owner,
          repo,
          path: fetched.path,
          frontmatter: parsed.frontmatter,
          body: parsed.body,
          url: `https://github.com/${owner}/${repo}/blob/${fetched.branch}/${fetched.path}`,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
};
