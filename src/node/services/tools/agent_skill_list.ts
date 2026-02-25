import * as fsPromises from "fs/promises";
import * as path from "path";
import { tool } from "ai";

import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { AgentSkillDescriptorSchema, SkillNameSchema } from "@/common/orpc/schemas";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { AgentSkillListToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { log } from "@/node/services/log";
import { getMuxHomeFromWorkspaceSessionDir } from "./muxHome";
import { hasErrorCode } from "./skillFileUtils";

interface AgentSkillListToolArgs {
  includeUnadvertised?: boolean | null;
}

async function listSkillDirectories(skillsRoot: string): Promise<string[]> {
  try {
    const entries = await fsPromises.readdir(skillsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }
}

async function readGlobalSkillDescriptor(
  skillsRoot: string,
  directoryNameRaw: string
): Promise<AgentSkillDescriptor | null> {
  const parsedDirectoryName = SkillNameSchema.safeParse(directoryNameRaw);
  if (!parsedDirectoryName.success) {
    log.warn(`Skipping invalid global skill directory name '${directoryNameRaw}' in ${skillsRoot}`);
    return null;
  }

  const directoryName = parsedDirectoryName.data;
  const skillFilePath = path.join(skillsRoot, directoryName, "SKILL.md");

  let stat: Awaited<ReturnType<typeof fsPromises.stat>>;
  try {
    stat = await fsPromises.stat(skillFilePath);
  } catch {
    log.warn(
      `Skipping global skill '${directoryName}' because SKILL.md is missing: ${skillFilePath}`
    );
    return null;
  }

  if (!stat.isFile()) {
    log.warn(`Skipping global skill '${directoryName}' because SKILL.md is not a regular file`);
    return null;
  }

  let content: string;
  try {
    content = await fsPromises.readFile(skillFilePath, "utf-8");
  } catch (error) {
    log.warn(
      `Skipping global skill '${directoryName}' because SKILL.md could not be read: ${getErrorMessage(error)}`
    );
    return null;
  }

  try {
    const parsed = parseSkillMarkdown({
      content,
      byteSize: stat.size,
      directoryName,
    });

    const descriptorResult = AgentSkillDescriptorSchema.safeParse({
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      scope: "global",
      advertise: parsed.frontmatter.advertise,
    });

    if (!descriptorResult.success) {
      log.warn(
        `Skipping global skill '${directoryName}' because descriptor validation failed: ${descriptorResult.error.message}`
      );
      return null;
    }

    return descriptorResult.data;
  } catch (error) {
    log.warn(
      `Skipping global skill '${directoryName}' because SKILL.md is invalid: ${getErrorMessage(error)}`
    );
    return null;
  }
}

export const createAgentSkillListTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.agent_skill_list.description,
    inputSchema: TOOL_DEFINITIONS.agent_skill_list.schema,
    execute: async ({
      includeUnadvertised,
    }: AgentSkillListToolArgs): Promise<AgentSkillListToolResult> => {
      try {
        if (config.workspaceId !== MUX_HELP_CHAT_WORKSPACE_ID) {
          return {
            success: false,
            error: "agent_skill_list is only available in the Chat with Mux system workspace",
          };
        }

        const muxHome = getMuxHomeFromWorkspaceSessionDir(config, "agent_skill_list");

        let muxHomeReal: string;
        try {
          muxHomeReal = await fsPromises.realpath(muxHome);
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) {
            return {
              success: true,
              skills: [],
            };
          }

          throw error;
        }

        const skillsRoot = path.join(muxHomeReal, "skills");
        const directoryNames = await listSkillDirectories(skillsRoot);

        const skills: AgentSkillDescriptor[] = [];
        for (const directoryName of directoryNames) {
          const descriptor = await readGlobalSkillDescriptor(skillsRoot, directoryName);
          if (!descriptor) {
            continue;
          }

          if (includeUnadvertised !== true && descriptor.advertise === false) {
            continue;
          }

          skills.push(descriptor);
        }

        skills.sort((a, b) => a.name.localeCompare(b.name));

        return {
          success: true,
          skills,
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to list global skills: ${getErrorMessage(error)}`,
        };
      }
    },
  });
};
