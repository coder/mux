import * as fsPromises from "fs/promises";
import * as path from "path";
import { tool } from "ai";

import { SkillNameSchema } from "@/common/orpc/schemas";
import type { AgentSkillDeleteToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import type { FileStat } from "@/node/runtime/Runtime";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { quoteRuntimeProbePath } from "./runtimePathShellQuote";
import {
  ensureRuntimePathWithinWorkspace,
  inspectContainmentOnRuntime,
  resolveContainedSkillFilePathOnRuntime,
} from "./runtimeSkillPathUtils";
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
 * Tool that deletes skills/files under the contextual skills directory.
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
        const skillCtx = resolveSkillStorageContext({
          runtime: config.runtime,
          workspacePath: config.cwd,
          muxScope: config.muxScope ?? null,
        });

        if (skillCtx.kind === "project-runtime") {
          const skillsRoot = config.runtime.normalizePath(".mux/skills", skillCtx.workspacePath);
          const skillDir = config.runtime.normalizePath(parsedName.data, skillsRoot);
          await ensureRuntimePathWithinWorkspace(
            config.runtime,
            skillCtx.workspacePath,
            skillDir,
            "Skill directory"
          );
          const targetMode = target ?? "file";

          if (targetMode === "skill") {
            let skillDirStat: FileStat;
            try {
              skillDirStat = await config.runtime.stat(skillDir);
            } catch (error) {
              const message = getErrorMessage(error);
              if (/enoent|no such file|does not exist/i.test(message)) {
                return {
                  success: false,
                  error: `Skill not found: ${parsedName.data}`,
                };
              }

              return {
                success: false,
                error: message,
              };
            }

            if (!skillDirStat.isDirectory) {
              return {
                success: false,
                error: `Skill not found: ${parsedName.data}`,
              };
            }

            const rmSkillResult = await execBuffered(
              config.runtime,
              `rm -rf ${quoteRuntimeProbePath(skillDir)}`,
              {
                cwd: skillCtx.workspacePath,
                timeout: 10,
              }
            );

            if (rmSkillResult.exitCode !== 0) {
              const details = (rmSkillResult.stderr || rmSkillResult.stdout).trim();
              return {
                success: false,
                error: details || `Failed to delete skill directory '${parsedName.data}'`,
              };
            }

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

          let resolvedPath: string;
          try {
            ({ resolvedPath } = await resolveContainedSkillFilePathOnRuntime(
              config.runtime,
              skillDir,
              filePath
            ));
            const targetContainment = await inspectContainmentOnRuntime(
              config.runtime,
              skillDir,
              resolvedPath
            );
            if (targetContainment.leafSymlink) {
              return {
                success: false,
                error: `Target file is a symbolic link and cannot be accessed: ${filePath}`,
              };
            }
            await ensureRuntimePathWithinWorkspace(
              config.runtime,
              skillCtx.workspacePath,
              resolvedPath,
              "Skill file"
            );
          } catch (error) {
            return {
              success: false,
              error: getErrorMessage(error),
            };
          }

          const rmFileResult = await execBuffered(
            config.runtime,
            `rm ${quoteRuntimeProbePath(resolvedPath)}`,
            {
              cwd: skillCtx.workspacePath,
              timeout: 10,
            }
          );

          if (rmFileResult.exitCode !== 0) {
            const details = (rmFileResult.stderr || rmFileResult.stdout).trim();
            if (/No such file/i.test(details)) {
              return {
                success: false,
                error: `File not found in skill '${parsedName.data}': ${filePath}`,
              };
            }

            return {
              success: false,
              error: details || `Failed to delete file in skill '${parsedName.data}'`,
            };
          }

          return {
            success: true,
            deleted: "file",
          };
        }

        const { muxScope } = config;
        if (!muxScope) {
          throw new Error("agent_skill_delete requires muxScope");
        }

        const skillsRoot =
          muxScope.type === "project"
            ? path.join(muxScope.projectRoot, ".mux", "skills")
            : path.join(muxScope.muxHome, "skills");
        // Containment is anchored at workspace root (project) or mux home (global).
        const containmentRoot =
          muxScope.type === "project" ? muxScope.projectRoot : muxScope.muxHome;

        const skillDir = path.join(skillsRoot, parsedName.data);

        let skillDirStat;
        try {
          ({ skillDirStat } = await validateLocalSkillDirectory(containmentRoot, skillDir));
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) {
            // A missing mux home/workspace root means there cannot be a contained skill to delete.
            return {
              success: false,
              error: `Skill not found: ${parsedName.data}`,
            };
          }

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
