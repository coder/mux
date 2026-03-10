import * as fsPromises from "fs/promises";
import * as path from "path";
import { tool } from "ai";

import { AgentSkillDescriptorSchema, SkillNameSchema } from "@/common/orpc/schemas";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { AgentSkillListToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  discoverAgentSkills,
  getDefaultAgentSkillsRoots,
  type AgentSkillsRoots,
} from "@/node/services/agentSkills/agentSkillsService";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import { log } from "@/node/services/log";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { ensurePathContained, hasErrorCode } from "./skillFileUtils";

interface AgentSkillListToolArgs {
  includeUnadvertised?: boolean | null;
}

interface SkillDirectoryEntry {
  name: string;
  isSymbolicLink: boolean;
}

async function listSkillDirectories(skillsRoot: string): Promise<SkillDirectoryEntry[]> {
  try {
    const entries = await fsPromises.readdir(skillsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => ({
        name: entry.name,
        isSymbolicLink: entry.isSymbolicLink(),
      }));
  } catch (error) {
    log.warn(
      `Skipping skills root '${skillsRoot}' because directory entries could not be read: ${getErrorMessage(error)}`
    );
    return [];
  }
}

async function readSkillDescriptor(
  skillsRoot: string,
  directoryNameRaw: string,
  scope: "global" | "project",
  containmentRoot: string
): Promise<AgentSkillDescriptor | null> {
  const parsedDirectoryName = SkillNameSchema.safeParse(directoryNameRaw);
  if (!parsedDirectoryName.success) {
    log.warn(
      `Skipping invalid ${scope} skill directory name '${directoryNameRaw}' in ${skillsRoot}`
    );
    return null;
  }

  const directoryName = parsedDirectoryName.data;
  const skillFilePath = path.join(skillsRoot, directoryName, "SKILL.md");

  // Validate SKILL.md canonical path stays within the containment root before any read.
  // This prevents repo-controlled symlinks from escaping the project boundary.
  let containedPath: string;
  try {
    containedPath = await ensurePathContained(containmentRoot, skillFilePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      log.warn(
        `Skipping ${scope} skill '${directoryName}' because SKILL.md is missing: ${skillFilePath}`
      );
      return null;
    }
    log.warn(
      `Skipping ${scope} skill '${directoryName}' because SKILL.md escapes containment root`
    );
    return null;
  }

  let stat: Awaited<ReturnType<typeof fsPromises.stat>>;
  try {
    stat = await fsPromises.stat(containedPath);
  } catch {
    log.warn(
      `Skipping ${scope} skill '${directoryName}' because SKILL.md is missing: ${skillFilePath}`
    );
    return null;
  }

  if (!stat.isFile()) {
    log.warn(`Skipping ${scope} skill '${directoryName}' because SKILL.md is not a regular file`);
    return null;
  }

  if (stat.size > MAX_FILE_SIZE) {
    log.warn(
      `Skipping ${scope} skill '${directoryName}' because SKILL.md is too large (${stat.size} bytes)`
    );
    return null;
  }

  let content: string;
  try {
    content = await fsPromises.readFile(containedPath, "utf-8");
  } catch (error) {
    log.warn(
      `Skipping ${scope} skill '${directoryName}' because SKILL.md could not be read: ${getErrorMessage(error)}`
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
      scope,
      advertise: parsed.frontmatter.advertise,
    });

    if (!descriptorResult.success) {
      log.warn(
        `Skipping ${scope} skill '${directoryName}' because descriptor validation failed: ${descriptorResult.error.message}`
      );
      return null;
    }

    return descriptorResult.data;
  } catch (error) {
    log.warn(
      `Skipping ${scope} skill '${directoryName}' because SKILL.md is invalid: ${getErrorMessage(error)}`
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
      if (!config.cwd || config.cwd.trim().length === 0) {
        return {
          success: false,
          error: "Tool misconfigured: cwd is required.",
        };
      }

      try {
        const skillCtx = resolveSkillStorageContext({
          runtime: config.runtime,
          workspacePath: config.cwd,
          muxScope: config.muxScope ?? null,
        });

        if (skillCtx.kind === "project-runtime") {
          // Only enumerate roots that paired mutation tools (write/delete) can target.
          // Excludes .agents/skills and ~/.agents/skills which are read-only legacy roots.
          const writableRoots: AgentSkillsRoots = {
            projectRoot: skillCtx.runtime.normalizePath(".mux/skills", skillCtx.workspacePath),
            globalRoot: getDefaultAgentSkillsRoots(skillCtx.runtime, skillCtx.workspacePath)
              .globalRoot,
          };

          const discovered = await discoverAgentSkills(skillCtx.runtime, skillCtx.workspacePath, {
            roots: writableRoots,
            containment: skillCtx.containment,
            dedupeByName: false,
          });
          const skills = discovered
            .filter((skill) => skill.scope !== "built-in")
            .filter((skill) => includeUnadvertised === true || skill.advertise !== false)
            .sort((a, b) => a.name.localeCompare(b.name));

          return {
            success: true,
            skills,
          };
        }

        const { muxScope } = config;
        if (!muxScope) {
          throw new Error("agent_skill_list requires muxScope");
        }

        // Always list global skills; also list project skills when in a project workspace.
        const roots: Array<{
          skillsRoot: string;
          containmentRoot: string;
          scope: "global" | "project";
        }> = [
          {
            skillsRoot: path.join(muxScope.muxHome, "skills"),
            containmentRoot: muxScope.muxHome,
            scope: "global",
          },
        ];
        if (muxScope.type === "project") {
          // Project skills listed first so they appear before global ones
          roots.unshift({
            skillsRoot: path.join(muxScope.projectRoot, ".mux", "skills"),
            containmentRoot: muxScope.projectRoot,
            scope: "project",
          });
        }

        const skills: AgentSkillDescriptor[] = [];
        for (const { skillsRoot, containmentRoot, scope } of roots) {
          let skillsRootReal: string;
          try {
            skillsRootReal = await fsPromises.realpath(skillsRoot);
          } catch (error) {
            log.warn(
              `Skipping ${scope} skills root '${skillsRoot}' because path could not be resolved: ${getErrorMessage(error)}`
            );
            continue;
          }

          // Skip roots that resolve outside their containment boundary
          // (e.g., project .mux is a symlink to an external directory).
          try {
            await ensurePathContained(containmentRoot, skillsRootReal);
          } catch {
            log.warn(`Skipping ${scope} skills root: resolves outside containment root`);
            continue;
          }

          const directoryEntries = await listSkillDirectories(skillsRootReal);
          for (const entry of directoryEntries) {
            // Project scope: reject symlinked skill directories to avoid resolving
            // repo-controlled entries to out-of-project locations.
            if (scope === "project" && entry.isSymbolicLink) {
              log.warn(
                `Skipping project skill '${entry.name}': skill directory is a symbolic link`
              );
              continue;
            }

            const descriptor = await readSkillDescriptor(
              skillsRootReal,
              entry.name,
              scope,
              containmentRoot
            );
            if (!descriptor) {
              continue;
            }

            if (includeUnadvertised !== true && descriptor.advertise === false) {
              continue;
            }

            skills.push(descriptor);
          }
        }

        skills.sort((a, b) => a.name.localeCompare(b.name));

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
          error: `Failed to list skills: ${getErrorMessage(error)}`,
        };
      }
    },
  });
};
