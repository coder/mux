import * as fsPromises from "fs/promises";
import * as path from "path";
import { tool } from "ai";

import { getCanonicalProjectMetadataRelativePath } from "@/common/compat/legacyMux";
import { SkillNameSchema } from "@/common/orpc/schemas";
import type { AgentSkillDeleteToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { quoteRuntimeProbePath } from "./runtimePathShellQuote";
import {
  ensureRuntimePathWithinWorkspace,
  getProjectSkillDirs,
  inspectContainmentOnRuntime,
  migrateLegacyProjectSkill,
  resolveContainedSkillFilePathOnRuntime,
  validateProjectSkillDirs,
} from "./runtimeSkillPathUtils";
import {
  hasErrorCode,
  isSkillMarkdownRootFile,
  resolveContainedSkillFilePath,
  SKILL_FILENAME,
  validateLocalSkillDirectory,
} from "./skillFileUtils";

interface AgentSkillDeleteToolArgs {
  name: string;
  target?: string | null;
  filePath?: string | null;
  confirm: boolean;
}

function deleteFailure(error: unknown, prefix = ""): AgentSkillDeleteToolResult {
  return { success: false, error: prefix + getErrorMessage(error) };
}

/** Delete skills or files under the contextual skills directory. */
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
          xumScope: config.xumScope ?? null,
        });

        const targetMode = target ?? "file";
        const projectSkillDirs =
          targetMode === "skill"
            ? getProjectSkillDirs(skillCtx, parsedName.data)
            : await migrateLegacyProjectSkill(skillCtx, parsedName.data);

        const legacyManifestPath =
          targetMode === "file" &&
          filePath != null &&
          isSkillMarkdownRootFile(path.posix.normalize(filePath.replaceAll("\\", "/"))) &&
          projectSkillDirs != null
            ? skillCtx.runtime.normalizePath(SKILL_FILENAME, projectSkillDirs[1])
            : null;
        if (legacyManifestPath != null && projectSkillDirs != null) {
          await validateProjectSkillDirs(skillCtx, projectSkillDirs);
        }

        if (targetMode === "skill" && projectSkillDirs != null) {
          const boundary = await validateProjectSkillDirs(skillCtx, projectSkillDirs);
          const stats = await Promise.all(
            projectSkillDirs.map((dir) => skillCtx.runtime.stat(dir).catch(() => null))
          );
          if (!stats.some((stat) => stat?.isDirectory)) {
            return { success: false, error: `Skill not found: ${parsedName.data}` };
          }
          const result = await execBuffered(
            skillCtx.runtime,
            `rm -rf ${projectSkillDirs.map(quoteRuntimeProbePath).join(" ")}`,
            { cwd: boundary, timeout: 10 }
          );
          if (result.exitCode !== 0) {
            return { success: false, error: result.stderr.trim() || "Failed to delete skill" };
          }
          return { success: true, deleted: "skill" };
        }

        if (skillCtx.kind === "project-runtime") {
          const skillsRoot = config.runtime.normalizePath(
            getCanonicalProjectMetadataRelativePath("skills"),
            skillCtx.workspacePath
          );
          const skillDir = config.runtime.normalizePath(parsedName.data, skillsRoot);
          await ensureRuntimePathWithinWorkspace(
            config.runtime,
            skillCtx.workspacePath,
            skillDir,
            "Skill directory"
          );
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
            return deleteFailure(error);
          }

          const rmCommand =
            legacyManifestPath == null
              ? `rm ${quoteRuntimeProbePath(resolvedPath)}`
              : `rm -f ${quoteRuntimeProbePath(legacyManifestPath)} && rm ${quoteRuntimeProbePath(resolvedPath)}`;
          const rmFileResult = await execBuffered(config.runtime, rmCommand, {
            cwd: skillCtx.workspacePath,
            timeout: 10,
          });

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

        const { xumScope } = config;
        if (!xumScope) {
          throw new Error("agent_skill_delete requires xumScope");
        }

        const skillsRoot =
          xumScope.type === "project"
            ? path.join(xumScope.projectRoot, getCanonicalProjectMetadataRelativePath("skills"))
            : path.join(xumScope.xumHome, "skills");
        // Anchor above metadata directories so aliases cannot escape the project or home.
        const containmentRoot =
          xumScope.type === "project" ? xumScope.projectRoot : xumScope.xumHome;

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

          return deleteFailure(error);
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

        if (targetMode === "skill") {
          await Promise.all(
            (projectSkillDirs ?? [skillDir]).map((dir) =>
              fsPromises.rm(dir, { recursive: true, force: true })
            )
          );
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
          return deleteFailure(error);
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

        if (legacyManifestPath != null) await fsPromises.rm(legacyManifestPath, { force: true });
        await fsPromises.unlink(targetPath);

        return {
          success: true,
          deleted: "file",
        };
      } catch (error) {
        return deleteFailure(error, "Failed to delete skill: ");
      }
    },
  });
};
