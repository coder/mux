import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Runtime } from "@/node/runtime/Runtime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { shellQuote } from "@/node/runtime/backgroundCommands";
import { getErrorMessage } from "@/common/utils/errors";
import { execBuffered, readFileString } from "@/node/utils/runtime/helpers";

import {
  AgentSkillDescriptorSchema,
  AgentSkillPackageSchema,
  SkillNameSchema,
} from "@/common/orpc/schemas";
import type {
  AgentSkillDescriptor,
  AgentSkillIssue,
  AgentSkillPackage,
  AgentSkillScope,
  SkillName,
} from "@/common/types/agentSkill";
import { log } from "@/node/services/log";
import { validateFileSize } from "@/node/services/tools/fileCommon";
import { AgentSkillParseError, parseSkillMarkdown } from "./parseSkillMarkdown";
import { getBuiltInSkillByName, getBuiltInSkillDescriptors } from "./builtInSkillDefinitions";

const GLOBAL_SKILLS_ROOT = "~/.mux/skills";
const UNIVERSAL_SKILLS_ROOT = "~/.agents/skills";

export interface AgentSkillsRoots {
  projectRoot: string;
  globalRoot: string;
  universalRoot?: string;
}

export function getDefaultAgentSkillsRoots(
  runtime: Runtime,
  workspacePath: string
): AgentSkillsRoots {
  if (!workspacePath) {
    throw new Error("getDefaultAgentSkillsRoots: workspacePath is required");
  }

  return {
    projectRoot: runtime.normalizePath(".mux/skills", workspacePath),
    globalRoot: GLOBAL_SKILLS_ROOT,
    universalRoot: UNIVERSAL_SKILLS_ROOT,
  };
}

function getGlobalSkillRoots(roots: AgentSkillsRoots): string[] {
  const orderedRoots = [roots.globalRoot, roots.universalRoot].filter(
    (root): root is string => root != null && root.length > 0
  );

  return Array.from(new Set(orderedRoots));
}

async function listSkillDirectoriesFromLocalFs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    // Include symlinks to directories — users commonly symlink skill dirs
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listSkillDirectoriesFromRuntime(
  runtime: Runtime,
  root: string,
  options: { cwd: string }
): Promise<string[]> {
  if (!options.cwd) {
    throw new Error("listSkillDirectoriesFromRuntime: options.cwd is required");
  }

  const quotedRoot = shellQuote(root);
  // -L follows symlinks so symlinked skill directories are discovered
  const command =
    `if [ -d ${quotedRoot} ]; then ` +
    `find -L ${quotedRoot} -mindepth 1 -maxdepth 1 -type d -exec basename {} \\; ; ` +
    `fi`;

  const result = await execBuffered(runtime, command, { cwd: options.cwd, timeout: 10 });
  if (result.exitCode !== 0) {
    log.warn(`Failed to read skills directory ${root}: ${result.stderr || result.stdout}`);
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readSkillDescriptorFromDir(
  runtime: Runtime,
  skillDir: string,
  directoryName: SkillName,
  scope: AgentSkillScope,
  options?: { invalidSkills?: AgentSkillIssue[] }
): Promise<AgentSkillDescriptor | null> {
  const skillFilePath = runtime.normalizePath("SKILL.md", skillDir);

  let stat;
  try {
    stat = await runtime.stat(skillFilePath);
  } catch {
    options?.invalidSkills?.push({
      directoryName,
      scope,
      displayPath: skillFilePath,
      message: "SKILL.md is missing or unreadable.",
      hint: "Create a SKILL.md file with YAML frontmatter (--- ... ---).",
    });
    return null;
  }

  if (stat.isDirectory) {
    options?.invalidSkills?.push({
      directoryName,
      scope,
      displayPath: skillFilePath,
      message: "SKILL.md is a directory (expected a file).",
      hint: "Replace SKILL.md with a regular file.",
    });
    return null;
  }

  // Avoid reading very large files into memory (parseSkillMarkdown enforces the same limit).
  const sizeValidation = validateFileSize(stat);
  if (sizeValidation) {
    log.warn(`Skipping skill '${directoryName}' (${scope}): ${sizeValidation.error}`);
    options?.invalidSkills?.push({
      directoryName,
      scope,
      displayPath: skillFilePath,
      message: sizeValidation.error,
      hint: "Reduce SKILL.md size below 1MB.",
    });
    return null;
  }

  let content: string;
  try {
    content = await readFileString(runtime, skillFilePath);
  } catch (err) {
    const message = getErrorMessage(err);
    log.warn(`Failed to read SKILL.md for ${directoryName}: ${message}`);
    options?.invalidSkills?.push({
      directoryName,
      scope,
      displayPath: skillFilePath,
      message: `Failed to read SKILL.md: ${message}`,
      hint: "Check file permissions and ensure the file is UTF-8 text.",
    });
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
      advertise: parsed.frontmatter.advertise,
    };

    const validated = AgentSkillDescriptorSchema.safeParse(descriptor);
    if (!validated.success) {
      log.warn(`Invalid agent skill descriptor for ${directoryName}: ${validated.error.message}`);
      options?.invalidSkills?.push({
        directoryName,
        scope,
        displayPath: skillFilePath,
        message: `Invalid agent skill descriptor: ${validated.error.message}`,
        hint: "Fix SKILL.md frontmatter fields to satisfy the skill schema.",
      });
      return null;
    }

    return validated.data;
  } catch (err) {
    const message = err instanceof AgentSkillParseError ? err.message : getErrorMessage(err);
    log.warn(`Skipping invalid skill '${directoryName}' (${scope}): ${message}`);
    options?.invalidSkills?.push({
      directoryName,
      scope,
      displayPath: skillFilePath,
      message,
      hint: "Fix SKILL.md frontmatter (name + description) and ensure it matches the directory name.",
    });
    return null;
  }
}

export async function discoverAgentSkills(
  runtime: Runtime,
  workspacePath: string,
  options?: { roots?: AgentSkillsRoots }
): Promise<AgentSkillDescriptor[]> {
  if (!workspacePath) {
    throw new Error("discoverAgentSkills: workspacePath is required");
  }

  const roots = options?.roots ?? getDefaultAgentSkillsRoots(runtime, workspacePath);

  const byName = new Map<SkillName, AgentSkillDescriptor>();

  // Project skills take precedence over global roots.
  const scans: Array<{ scope: AgentSkillScope; root: string }> = [
    { scope: "project", root: roots.projectRoot },
    ...getGlobalSkillRoots(roots).map((root) => ({ scope: "global" as const, root })),
  ];

  for (const scan of scans) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await runtime.resolvePath(scan.root);
    } catch (err) {
      log.warn(`Failed to resolve skills root ${scan.root}: ${getErrorMessage(err)}`);
      continue;
    }

    const directoryNames =
      runtime instanceof SSHRuntime
        ? await listSkillDirectoriesFromRuntime(runtime, resolvedRoot, { cwd: workspacePath })
        : await listSkillDirectoriesFromLocalFs(resolvedRoot);

    for (const directoryNameRaw of directoryNames) {
      const nameParsed = SkillNameSchema.safeParse(directoryNameRaw);
      if (!nameParsed.success) {
        log.warn(`Skipping invalid skill directory name '${directoryNameRaw}' in ${resolvedRoot}`);
        continue;
      }

      const directoryName = nameParsed.data;

      if (scan.scope === "global" && byName.has(directoryName)) {
        continue;
      }

      const skillDir = runtime.normalizePath(directoryName, resolvedRoot);
      const descriptor = await readSkillDescriptorFromDir(
        runtime,
        skillDir,
        directoryName,
        scan.scope
      );
      if (!descriptor) continue;

      // Precedence: project overwrites global.
      byName.set(descriptor.name, descriptor);
    }
  }

  // Add built-in skills (lowest precedence - only if not overridden by project/global)
  for (const builtIn of getBuiltInSkillDescriptors()) {
    if (!byName.has(builtIn.name)) {
      byName.set(builtIn.name, builtIn);
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export interface DiscoverAgentSkillsDiagnosticsResult {
  skills: AgentSkillDescriptor[];
  invalidSkills: AgentSkillIssue[];
}

export async function discoverAgentSkillsDiagnostics(
  runtime: Runtime,
  workspacePath: string,
  options?: { roots?: AgentSkillsRoots }
): Promise<DiscoverAgentSkillsDiagnosticsResult> {
  if (!workspacePath) {
    throw new Error("discoverAgentSkillsDiagnostics: workspacePath is required");
  }

  const roots = options?.roots ?? getDefaultAgentSkillsRoots(runtime, workspacePath);

  const byName = new Map<SkillName, AgentSkillDescriptor>();
  const invalidSkills: AgentSkillIssue[] = [];

  // Project skills take precedence over global roots.
  const scans: Array<{ scope: AgentSkillScope; root: string }> = [
    { scope: "project", root: roots.projectRoot },
    ...getGlobalSkillRoots(roots).map((root) => ({ scope: "global" as const, root })),
  ];

  for (const scan of scans) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await runtime.resolvePath(scan.root);
    } catch (err) {
      log.warn(`Failed to resolve skills root ${scan.root}: ${getErrorMessage(err)}`);
      continue;
    }

    const directoryNames =
      runtime instanceof SSHRuntime
        ? await listSkillDirectoriesFromRuntime(runtime, resolvedRoot, { cwd: workspacePath })
        : await listSkillDirectoriesFromLocalFs(resolvedRoot);

    for (const directoryNameRaw of directoryNames) {
      const nameParsed = SkillNameSchema.safeParse(directoryNameRaw);
      if (!nameParsed.success) {
        log.warn(`Skipping invalid skill directory name '${directoryNameRaw}' in ${resolvedRoot}`);
        invalidSkills.push({
          directoryName: directoryNameRaw,
          scope: scan.scope,
          displayPath: runtime.normalizePath(directoryNameRaw, resolvedRoot),
          message: `Invalid skill directory name '${directoryNameRaw}'.`,
          hint: "Rename the directory to kebab-case (lowercase letters/numbers/hyphens).",
        });
        continue;
      }

      const directoryName = nameParsed.data;

      if (scan.scope === "global" && byName.has(directoryName)) {
        continue;
      }

      const skillDir = runtime.normalizePath(directoryName, resolvedRoot);
      const descriptor = await readSkillDescriptorFromDir(
        runtime,
        skillDir,
        directoryName,
        scan.scope,
        {
          invalidSkills,
        }
      );
      if (!descriptor) continue;

      // Precedence: project overwrites global.
      byName.set(descriptor.name, descriptor);
    }
  }

  // Add built-in skills (lowest precedence - only if not overridden by project/global)
  for (const builtIn of getBuiltInSkillDescriptors()) {
    if (!byName.has(builtIn.name)) {
      byName.set(builtIn.name, builtIn);
    }
  }

  const skills = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));

  const scopeOrder: Readonly<Record<AgentSkillScope, number>> = {
    project: 0,
    global: 1,
    "built-in": 2,
  };

  invalidSkills.sort((a, b) => {
    const scopeDiff = (scopeOrder[a.scope] ?? 0) - (scopeOrder[b.scope] ?? 0);
    if (scopeDiff !== 0) return scopeDiff;
    return a.directoryName.localeCompare(b.directoryName);
  });

  return {
    skills,
    invalidSkills,
  };
}

export interface ResolvedAgentSkill {
  package: AgentSkillPackage;
  skillDir: string;
}

async function readAgentSkillFromDir(
  runtime: Runtime,
  skillDir: string,
  directoryName: SkillName,
  scope: AgentSkillScope
): Promise<ResolvedAgentSkill> {
  const skillFilePath = runtime.normalizePath("SKILL.md", skillDir);

  const stat = await runtime.stat(skillFilePath);
  if (stat.isDirectory) {
    throw new Error(`SKILL.md is not a file: ${skillFilePath}`);
  }

  const sizeValidation = validateFileSize(stat);
  if (sizeValidation) {
    throw new Error(sizeValidation.error);
  }

  const content = await readFileString(runtime, skillFilePath);
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
  runtime: Runtime,
  workspacePath: string,
  name: SkillName,
  options?: { roots?: AgentSkillsRoots }
): Promise<ResolvedAgentSkill> {
  if (!workspacePath) {
    throw new Error("readAgentSkill: workspacePath is required");
  }

  const roots = options?.roots ?? getDefaultAgentSkillsRoots(runtime, workspacePath);

  // Project overrides all global roots.
  const candidates: Array<{ scope: AgentSkillScope; root: string }> = [
    { scope: "project", root: roots.projectRoot },
    ...getGlobalSkillRoots(roots).map((root) => ({ scope: "global" as const, root })),
  ];

  for (const candidate of candidates) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await runtime.resolvePath(candidate.root);
    } catch {
      continue;
    }

    const skillDir = runtime.normalizePath(name, resolvedRoot);

    try {
      const stat = await runtime.stat(skillDir);
      if (!stat.isDirectory) continue;

      return await readAgentSkillFromDir(runtime, skillDir, name, candidate.scope);
    } catch {
      continue;
    }
  }

  // Check built-in skills as fallback
  const builtIn = getBuiltInSkillByName(name);
  if (builtIn) {
    return {
      package: builtIn,
      // Built-in skills don't have a real skillDir on disk.
      // agent_skill_read_file handles built-in skills specially; this is a sentinel value.
      skillDir: `<built-in:${name}>`,
    };
  }

  throw new Error(`Agent skill not found: ${name}`);
}

function isAbsolutePathAny(filePath: string): boolean {
  if (filePath.startsWith("/") || filePath.startsWith("\\")) return true;
  // Windows drive letter paths (e.g., C:\foo or C:/foo)
  return /^[A-Za-z]:[\\/]/.test(filePath);
}

export function resolveAgentSkillFilePath(
  runtime: Runtime,
  skillDir: string,
  filePath: string
): string {
  if (!filePath) {
    throw new Error("filePath is required");
  }

  // Disallow absolute paths and home-relative paths.
  if (isAbsolutePathAny(filePath) || filePath.startsWith("~")) {
    throw new Error(`Invalid filePath (must be relative to the skill directory): ${filePath}`);
  }

  const pathModule = runtime instanceof SSHRuntime ? path.posix : path;

  // Resolve relative to skillDir and ensure it stays within skillDir.
  const resolved = pathModule.resolve(skillDir, filePath);
  const relative = pathModule.relative(skillDir, resolved);

  if (relative === "" || relative === ".") {
    throw new Error(`Invalid filePath (expected a file, got directory): ${filePath}`);
  }

  if (relative.startsWith("..") || pathModule.isAbsolute(relative)) {
    throw new Error(`Invalid filePath (path traversal): ${filePath}`);
  }

  return resolved;
}
