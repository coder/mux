import * as fsPromises from "fs/promises";
import * as path from "path";
import { tool } from "ai";

import { SkillNameSchema } from "@/common/orpc/schemas";
import type { AgentSkillWriteToolResult } from "@/common/types/tools";
import { FILE_EDIT_DIFF_OMITTED_MESSAGE } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import { readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import { generateDiff } from "@/node/services/tools/fileCommon";
import {
  hasErrorCode,
  isSkillMarkdownRootFile,
  resolveContainedSkillFilePath,
  SKILL_FILENAME,
  validateLocalSkillDirectory,
} from "./skillFileUtils";
import {
  ensureRuntimePathWithinWorkspace,
  inspectContainmentOnRuntime,
  resolveSkillFilePathForRuntime,
} from "./runtimeSkillPathUtils";

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
 * Tool that creates/updates files in the contextual skills directory.
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
      const parsedName = SkillNameSchema.safeParse(name);
      if (!parsedName.success) {
        return {
          success: false,
          error: parsedName.error.message,
        };
      }

      try {
        const relativeFilePath = filePath ?? SKILL_FILENAME;
        const skillCtx = resolveSkillStorageContext({
          runtime: config.runtime,
          workspacePath: config.cwd,
          muxScope: config.muxScope ?? null,
        });

        if (skillCtx.kind === "project-runtime") {
          const skillsRoot = config.runtime.normalizePath(".mux/skills", skillCtx.workspacePath);
          const skillDir = config.runtime.normalizePath(parsedName.data, skillsRoot);

          let resolvedTarget: ReturnType<typeof resolveSkillFilePathForRuntime>;
          try {
            resolvedTarget = resolveSkillFilePathForRuntime(
              config.runtime,
              skillDir,
              relativeFilePath
            );
          } catch (error) {
            return {
              success: false,
              error: getErrorMessage(error),
            };
          }

          // Canonicalize any casing variant of SKILL.md to the canonical path.
          // Validate the exact path we will write so casing aliases cannot bypass leaf-symlink checks.
          if (isSkillMarkdownRootFile(resolvedTarget.normalizedRelativePath)) {
            resolvedTarget = {
              ...resolvedTarget,
              resolvedPath: config.runtime.normalizePath(SKILL_FILENAME, skillDir),
              normalizedRelativePath: SKILL_FILENAME,
            };
          }

          const targetContainment = await inspectContainmentOnRuntime(
            config.runtime,
            skillDir,
            resolvedTarget.resolvedPath
          );
          if (!targetContainment.withinRoot) {
            return {
              success: false,
              error: `Invalid filePath (path escapes skill directory after symlink resolution): ${relativeFilePath}`,
            };
          }
          if (targetContainment.leafSymlink) {
            return {
              success: false,
              error: `Target file is a symbolic link and cannot be accessed: ${relativeFilePath}`,
            };
          }

          await ensureRuntimePathWithinWorkspace(
            config.runtime,
            skillCtx.workspacePath,
            resolvedTarget.resolvedPath,
            "Skill file"
          );

          const writesSkillMarkdown = isSkillMarkdownRootFile(
            resolvedTarget.normalizedRelativePath
          );
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
            originalContent = await readFileString(config.runtime, resolvedTarget.resolvedPath);
          } catch {
            // Best-effort read for diff generation.
          }

          await config.runtime.ensureDir(path.dirname(resolvedTarget.resolvedPath));
          await writeFileString(config.runtime, resolvedTarget.resolvedPath, contentToWrite);

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
        }

        const { muxScope } = config;
        if (!muxScope) {
          throw new Error("agent_skill_write requires muxScope");
        }

        const skillsRoot =
          muxScope.type === "project"
            ? path.join(muxScope.projectRoot, ".mux", "skills")
            : path.join(muxScope.muxHome, "skills");
        // Containment is anchored at workspace root (project) or mux home (global),
        // never at .mux — a symlinked .mux must not redirect skill operations outside.
        const containmentRoot =
          muxScope.type === "project" ? muxScope.projectRoot : muxScope.muxHome;

        const skillDir = path.join(skillsRoot, parsedName.data);

        try {
          if (muxScope.type !== "project") {
            // Self-heal a deleted mux home before realpath-based containment validation runs.
            await fsPromises.mkdir(containmentRoot, { recursive: true });
          }

          await validateLocalSkillDirectory(containmentRoot, skillDir);
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
