import * as fsPromises from "fs/promises";
import * as path from "path";
import { tool } from "ai";

import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { SkillNameSchema } from "@/common/orpc/schemas";
import type { AgentSkillWriteToolResult } from "@/common/types/tools";
import { FILE_EDIT_DIFF_OMITTED_MESSAGE } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { generateDiff } from "@/node/services/tools/fileCommon";
import { getMuxHomeFromWorkspaceSessionDir } from "@/node/services/tools/muxHome";
import {
  hasErrorCode,
  isSkillMarkdownRootFile,
  resolveContainedSkillFilePath,
  SKILL_FILENAME,
  validateLocalSkillDirectory,
} from "./skillFileUtils";

interface AgentSkillWriteToolArgs {
  name: string;
  filePath?: string | null;
  content: string;
}

/**
 * Keep SKILL.md frontmatter.name aligned with the validated tool argument.
 * This prevents avoidable write failures when an agent sends a human-friendly name or omits it.
 */
function injectSkillNameIntoFrontmatter(content: string, skillName: string): string {
  const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalizedContent.split("\n");

  if ((lines[0] ?? "").trim() !== "---") {
    return content;
  }

  const frontmatterEndLineIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---"
  );
  if (frontmatterEndLineIndex === -1) {
    return content;
  }

  const nameLineRegex = /^name\s*:\s*(.*)/;
  let nameLineIndex = -1;

  for (let i = 1; i < frontmatterEndLineIndex; i++) {
    if (nameLineRegex.test(lines[i] ?? "")) {
      nameLineIndex = i;
      break;
    }
  }

  if (nameLineIndex !== -1) {
    const match = nameLineRegex.exec(lines[nameLineIndex] ?? "");
    const existingValue = match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";

    if (existingValue === skillName) {
      return content;
    }

    lines[nameLineIndex] = `name: ${skillName}`;
  } else {
    lines.splice(1, 0, `name: ${skillName}`);
  }

  return lines.join("\n");
}

/**
 * Chat-with-Mux-only tool that creates/updates files in ~/.mux/skills/<name>/.
 */
export const createAgentSkillWriteTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.agent_skill_write.description,
    inputSchema: TOOL_DEFINITIONS.agent_skill_write.schema,
    execute: async ({
      name,
      filePath,
      content,
    }: AgentSkillWriteToolArgs): Promise<AgentSkillWriteToolResult> => {
      if (config.workspaceId !== MUX_HELP_CHAT_WORKSPACE_ID) {
        return {
          success: false,
          error: "agent_skill_write is only available in the Chat with Mux system workspace",
        };
      }

      const parsedName = SkillNameSchema.safeParse(name);
      if (!parsedName.success) {
        return {
          success: false,
          error: parsedName.error.message,
        };
      }

      try {
        const relativeFilePath = filePath ?? SKILL_FILENAME;

        const muxHome = getMuxHomeFromWorkspaceSessionDir(config, "agent_skill_write");
        await fsPromises.mkdir(muxHome, { recursive: true });

        const muxHomeReal = await fsPromises.realpath(muxHome);
        const skillDir = path.join(muxHomeReal, "skills", parsedName.data);

        try {
          await validateLocalSkillDirectory(skillDir, muxHomeReal);
        } catch (error) {
          return {
            success: false,
            error: getErrorMessage(error),
          };
        }

        let resolvedTarget: Awaited<ReturnType<typeof resolveContainedSkillFilePath>>;
        try {
          resolvedTarget = await resolveContainedSkillFilePath(skillDir, relativeFilePath, {
            allowMissingLeaf: true,
          });
        } catch (error) {
          return {
            success: false,
            error: getErrorMessage(error),
          };
        }

        // Canonicalize any casing variant of SKILL.md to the canonical path.
        // Prevents shadow files on case-sensitive filesystems and ensures validation always runs.
        if (isSkillMarkdownRootFile(resolvedTarget.normalizedRelativePath)) {
          resolvedTarget = {
            ...resolvedTarget,
            resolvedPath: path.join(skillDir, SKILL_FILENAME),
            normalizedRelativePath: SKILL_FILENAME,
          };
        }

        const writesSkillMarkdown = isSkillMarkdownRootFile(resolvedTarget.normalizedRelativePath);
        const contentToWrite = writesSkillMarkdown
          ? injectSkillNameIntoFrontmatter(content, parsedName.data)
          : content;

        if (writesSkillMarkdown) {
          try {
            parseSkillMarkdown({
              content: contentToWrite,
              byteSize: Buffer.byteLength(contentToWrite, "utf-8"),
              directoryName: parsedName.data,
            });
          } catch (error) {
            return {
              success: false,
              error: getErrorMessage(error),
            };
          }
        }

        let originalContent = "";
        try {
          const existingStat = await fsPromises.lstat(resolvedTarget.resolvedPath);
          if (existingStat.isSymbolicLink()) {
            return {
              success: false,
              error: "Refusing to write a symlinked skill file target",
            };
          }

          if (existingStat.isDirectory()) {
            return {
              success: false,
              error: `Path is a directory, not a file: ${relativeFilePath}`,
            };
          }

          originalContent = await fsPromises.readFile(resolvedTarget.resolvedPath, "utf-8");
        } catch (error) {
          if (!hasErrorCode(error, "ENOENT")) {
            throw error;
          }
        }

        await fsPromises.mkdir(path.dirname(resolvedTarget.resolvedPath), { recursive: true });
        await fsPromises.writeFile(resolvedTarget.resolvedPath, contentToWrite, "utf-8");

        const diff = generateDiff(resolvedTarget.resolvedPath, originalContent, contentToWrite);

        return {
          success: true,
          diff: FILE_EDIT_DIFF_OMITTED_MESSAGE,
          ui_only: {
            file_edit: {
              diff,
            },
          },
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to write skill file: ${getErrorMessage(error)}`,
        };
      }
    },
  });
};
