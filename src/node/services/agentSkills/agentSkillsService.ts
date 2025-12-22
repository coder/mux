import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  AgentSkillDescriptorSchema,
  AgentSkillPackageSchema,
  SkillNameSchema,
} from "@/common/orpc/schemas";
import type {
  AgentSkillDescriptor,
  AgentSkillPackage,
  AgentSkillScope,
  SkillName,
} from "@/common/types/agentSkill";
import { log } from "@/node/services/log";
import { PlatformPaths } from "@/node/utils/paths.main";
import { AgentSkillParseError, parseSkillMarkdown } from "./parseSkillMarkdown";

const GLOBAL_SKILLS_ROOT = "~/.mux/skills";

export interface AgentSkillsRoots {
  projectRoot: string;
  globalRoot: string;
}

export function getDefaultAgentSkillsRoots(projectPath: string): AgentSkillsRoots {
  return {
    projectRoot: path.join(projectPath, ".mux", "skills"),
    globalRoot: PlatformPaths.expandHome(GLOBAL_SKILLS_ROOT),
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readSkillDescriptorFromDir(
  skillDir: string,
  directoryName: SkillName,
  scope: AgentSkillScope
): Promise<AgentSkillDescriptor | null> {
  const skillFilePath = path.join(skillDir, "SKILL.md");

  let stat;
  try {
    stat = await fs.stat(skillFilePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    return null;
  }

  let content: string;
  try {
    content = await fs.readFile(skillFilePath, "utf-8");
  } catch (err) {
    log.warn(`Failed to read SKILL.md for ${directoryName}: ${formatError(err)}`);
    return null;
  }

  try {
    const parsed = parseSkillMarkdown({
      content,
      byteSize: stat.size,
      directoryName,
    });

    const descriptor: AgentSkillDescriptor = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      scope,
    };

    const validated = AgentSkillDescriptorSchema.safeParse(descriptor);
    if (!validated.success) {
      log.warn(`Invalid agent skill descriptor for ${directoryName}: ${validated.error.message}`);
      return null;
    }

    return validated.data;
  } catch (err) {
    const message = err instanceof AgentSkillParseError ? err.message : formatError(err);
    log.warn(`Skipping invalid skill '${directoryName}' (${scope}): ${message}`);
    return null;
  }
}

export async function discoverAgentSkills(
  projectPath: string,
  options?: { roots?: AgentSkillsRoots }
): Promise<AgentSkillDescriptor[]> {
  const roots = options?.roots ?? getDefaultAgentSkillsRoots(projectPath);

  const byName = new Map<SkillName, AgentSkillDescriptor>();

  // Project skills take precedence over global.
  const scans: Array<{ scope: AgentSkillScope; root: string }> = [
    { scope: "project", root: roots.projectRoot },
    { scope: "global", root: roots.globalRoot },
  ];

  for (const scan of scans) {
    const exists = await dirExists(scan.root);
    if (!exists) continue;

    let entries;
    try {
      entries = await fs.readdir(scan.root, { withFileTypes: true });
    } catch (err) {
      log.warn(`Failed to read skills directory ${scan.root}: ${formatError(err)}`);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const directoryNameRaw = entry.name;
      const nameParsed = SkillNameSchema.safeParse(directoryNameRaw);
      if (!nameParsed.success) {
        log.warn(`Skipping invalid skill directory name '${directoryNameRaw}' in ${scan.root}`);
        continue;
      }

      const directoryName = nameParsed.data;

      if (scan.scope === "global" && byName.has(directoryName)) {
        continue;
      }

      const skillDir = path.join(scan.root, directoryName);
      const descriptor = await readSkillDescriptorFromDir(skillDir, directoryName, scan.scope);
      if (!descriptor) continue;

      // Precedence: project overwrites global.
      byName.set(descriptor.name, descriptor);
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export interface ResolvedAgentSkill {
  package: AgentSkillPackage;
  skillDir: string;
}

async function readAgentSkillFromDir(
  skillDir: string,
  directoryName: SkillName,
  scope: AgentSkillScope
): Promise<ResolvedAgentSkill> {
  const skillFilePath = path.join(skillDir, "SKILL.md");

  const stat = await fs.stat(skillFilePath);
  if (!stat.isFile()) {
    throw new Error(`SKILL.md is not a file: ${skillFilePath}`);
  }

  const content = await fs.readFile(skillFilePath, "utf-8");
  const parsed = parseSkillMarkdown({
    content,
    byteSize: stat.size,
    directoryName,
  });

  const pkg: AgentSkillPackage = {
    scope,
    directoryName,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
  };

  const validated = AgentSkillPackageSchema.safeParse(pkg);
  if (!validated.success) {
    throw new Error(
      `Invalid agent skill package for '${directoryName}': ${validated.error.message}`
    );
  }

  return {
    package: validated.data,
    skillDir,
  };
}

export async function readAgentSkill(
  projectPath: string,
  name: SkillName,
  options?: { roots?: AgentSkillsRoots }
): Promise<ResolvedAgentSkill> {
  const roots = options?.roots ?? getDefaultAgentSkillsRoots(projectPath);

  // Project overrides global.
  const candidates: Array<{ scope: AgentSkillScope; root: string }> = [
    { scope: "project", root: roots.projectRoot },
    { scope: "global", root: roots.globalRoot },
  ];

  for (const candidate of candidates) {
    const skillDir = path.join(candidate.root, name);
    try {
      const stat = await fs.stat(skillDir);
      if (!stat.isDirectory()) continue;

      return await readAgentSkillFromDir(skillDir, name, candidate.scope);
    } catch {
      continue;
    }
  }

  throw new Error(`Agent skill not found: ${name}`);
}

export function resolveAgentSkillFilePath(skillDir: string, filePath: string): string {
  if (!filePath) {
    throw new Error("filePath is required");
  }

  // Disallow absolute paths and home-relative paths.
  if (path.isAbsolute(filePath) || filePath.startsWith("~")) {
    throw new Error(`Invalid filePath (must be relative to the skill directory): ${filePath}`);
  }

  // Resolve relative to skillDir and ensure it stays within skillDir.
  const resolved = path.resolve(skillDir, filePath);
  const relative = path.relative(skillDir, resolved);

  if (relative === "" || relative === ".") {
    // Allow reading the skill directory itself? No.
    throw new Error(`Invalid filePath (expected a file, got directory): ${filePath}`);
  }

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Invalid filePath (path traversal): ${filePath}`);
  }

  return resolved;
}
