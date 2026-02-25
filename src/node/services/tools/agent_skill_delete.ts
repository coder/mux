import * as fsPromises from "fs/promises";
import * as path from "path";
import { tool } from "ai";

import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { SkillNameSchema } from "@/common/orpc/schemas";
import type { AgentSkillDeleteToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { getMuxHomeFromWorkspaceSessionDir } from "@/node/services/tools/muxHome";
import {
  hasErrorCode,
  resolveContainedSkillFilePath,
  validateLocalSkillDirectory,
} from "./skillFileUtils";

interface AgentSkillDeleteToolArgs {
  name: string;
  target?: string | null;
  filePath?: string | null;
  confirm: boolean;
}

/**
 * Chat-with-Mux-only tool that deletes global skills/files under ~/.mux/skills/.
 */
export const createAgentSkillDeleteTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.agent_skill_delete.description,
    inputSchema: TOOL_DEFINITIONS.agent_skill_delete.schema,
    execute: async ({
      name,
      target,
      filePath,
      confirm,
    }: AgentSkillDeleteToolArgs): Promise<AgentSkillDeleteToolResult> => {
      if (config.workspaceId !== MUX_HELP_CHAT_WORKSPACE_ID) {
        return {
          success: false,
          error: "agent_skill_delete is only available in the Chat with Mux system workspace",
        };
      }

      if (!confirm) {
        return {
          success: false,
          error: "Refusing to delete skill content without confirm: true",
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
        const muxHome = getMuxHomeFromWorkspaceSessionDir(config, "agent_skill_delete");

        let muxHomeReal: string;
        try {
          muxHomeReal = await fsPromises.realpath(muxHome);
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) {
            return {
              success: false,
              error: `Skill not found: ${parsedName.data}`,
            };
          }
          throw error;
        }

        const skillDir = path.join(muxHomeReal, "skills", parsedName.data);

        let skillDirStat;
        try {
          ({ skillDirStat } = await validateLocalSkillDirectory(skillDir, muxHomeReal));
        } catch (error) {
          return {
            success: false,
            error: getErrorMessage(error),
          };
        }

        if (!skillDirStat) {
          return {
            success: false,
            error: `Skill not found: ${parsedName.data}`,
          };
        }

        if (!skillDirStat.isDirectory()) {
          return {
            success: false,
            error: `Skill path is not a directory: ${parsedName.data}`,
          };
        }

        const targetMode = target ?? "file";
        if (targetMode === "skill") {
          await fsPromises.rm(skillDir, { recursive: true });
          return {
            success: true,
            deleted: "skill",
          };
        }

        if (filePath == null) {
          return {
            success: false,
            error: "filePath is required when target is 'file'",
          };
        }

        let targetPath: string;
        try {
          ({ resolvedPath: targetPath } = await resolveContainedSkillFilePath(skillDir, filePath, {
            allowMissingLeaf: true,
          }));
        } catch (error) {
          return {
            success: false,
            error: getErrorMessage(error),
          };
        }

        let targetStat;
        try {
          targetStat = await fsPromises.lstat(targetPath);
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) {
            return {
              success: false,
              error: `File not found in skill '${parsedName.data}': ${filePath}`,
            };
          }
          throw error;
        }

        if (targetStat.isSymbolicLink()) {
          return {
            success: false,
            error: "Refusing to delete a symlinked skill file target",
          };
        }

        if (targetStat.isDirectory()) {
          return {
            success: false,
            error: `Path is a directory, not a file: ${filePath}`,
          };
        }

        await fsPromises.unlink(targetPath);
        return {
          success: true,
          deleted: "file",
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to delete skill: ${getErrorMessage(error)}`,
        };
      }
    },
  });
};
