import * as path from "node:path";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";

import type { Runtime } from "@/node/runtime/Runtime";
import { RemoteRuntime } from "@/node/runtime/RemoteRuntime";
import { resolveGlobalRuntime } from "@/node/runtime/hostGlobalMuxHome";
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
import type { ExtensionSkillSource } from "@/common/extensions/extensionSkillSource";
import { log } from "@/node/services/log";
import { validateFileSize } from "@/node/services/tools/fileCommon";
import { ensureRuntimePathWithinWorkspace } from "@/node/services/tools/runtimeSkillPathUtils";
import { ensurePathContained, hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { realpathOpenedFile } from "@/node/utils/openedFileRealpath";
import { AgentSkillParseError, parseSkillMarkdown } from "./parseSkillMarkdown";
import { getBuiltInSkillByName, getBuiltInSkillDescriptors } from "./builtInSkillDefinitions";
import type { ProjectSkillContainment } from "./skillStorageContext";

export const IMAGEGEN_BUILT_IN_SKILL_NAME = "imagegen" satisfies SkillName;

export const IMAGEGEN_SKILL_DISABLED_MESSAGE =
  "Built-in imagegen skill is only available when the Image Tools experiment is enabled.";

export function isBuiltInImagegenSkill(
  skill: Pick<AgentSkillDescriptor, "name" | "scope">
): boolean {
  return skill.scope === "built-in" && skill.name === IMAGEGEN_BUILT_IN_SKILL_NAME;
}

export function isBuiltInImagegenSkillPackage(skillPackage: AgentSkillPackage): boolean {
  return (
    skillPackage.scope === "built-in" &&
    skillPackage.frontmatter.name === IMAGEGEN_BUILT_IN_SKILL_NAME
  );
}

export function filterUnavailableImagegenSkills<
  T extends Pick<AgentSkillDescriptor, "name" | "scope">,
>(skills: T[], imageGenerationToolAvailable: boolean | undefined): T[] {
  if (imageGenerationToolAvailable === true) {
    return skills;
  }

  return skills.filter((skill) => !isBuiltInImagegenSkill(skill));
}

/**
 * True iff the resolved skill package is the built-in imagegen skill AND the
 * image generation tool is not currently available. Centralizes the
 * "is-imagegen + experiment-off" check used by tools/services that need to
 * refuse loading the built-in skill when the tool is gated off.
 */
export function isBuiltInImagegenSkillUnavailable(
  skillPackage: AgentSkillPackage,
  imageGenerationToolAvailable: boolean | undefined
): boolean {
  return isBuiltInImagegenSkillPackage(skillPackage) && imageGenerationToolAvailable !== true;
}

const UNIVERSAL_SKILLS_ROOT = "~/.agents/skills";

export interface AgentSkillsRoots {
  projectRoot: string;
  projectUniversalRoot?: string;
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
    projectUniversalRoot: runtime.normalizePath(".agents/skills", workspacePath),
    globalRoot: `${runtime.getMuxHome()}/skills`,
    universalRoot: UNIVERSAL_SKILLS_ROOT,
  };
}

function getProjectSkillRoots(roots: AgentSkillsRoots): string[] {
  const orderedRoots = [roots.projectRoot, roots.projectUniversalRoot].filter(
    (root): root is string => root != null && root.length > 0
  );

  return Array.from(new Set(orderedRoots));
}

function getGlobalSkillRoots(roots: AgentSkillsRoots): string[] {
  const orderedRoots = [roots.globalRoot, roots.universalRoot].filter(
    (root): root is string => root != null && root.length > 0
  );

  return Array.from(new Set(orderedRoots));
}

function buildScanOrder(roots: AgentSkillsRoots): Array<{ scope: AgentSkillScope; root: string }> {
  return [
    ...getProjectSkillRoots(roots).map((root) => ({ scope: "project" as const, root })),
    ...getGlobalSkillRoots(roots).map((root) => ({ scope: "global" as const, root })),
  ];
}

interface AgentSkillScanCandidate {
  scope: AgentSkillScope;
  root: string;
  runtime: Runtime;
}

function buildScanCandidates(
  runtime: Runtime,
  workspacePath: string,
  roots: AgentSkillsRoots
): AgentSkillScanCandidate[] {
  const globalRuntime = resolveGlobalRuntime(runtime, workspacePath);

  return buildScanOrder(roots).map((scan) => ({
    ...scan,
    runtime: scan.scope === "global" ? globalRuntime : runtime,
  }));
}

const NO_PROJECT_SKILL_CONTAINMENT: ProjectSkillContainment = { kind: "none" };

function resolveProjectSkillContainment(options?: {
  containment?: ProjectSkillContainment;
  projectContainmentRoot?: string | null;
}): ProjectSkillContainment {
  if (options?.containment != null) {
    return options.containment;
  }

  if (options?.projectContainmentRoot != null) {
    return {
      kind: "local",
      root: options.projectContainmentRoot,
    };
  }

  return NO_PROJECT_SKILL_CONTAINMENT;
}

async function assertProjectSkillContained(args: {
  runtime: Runtime;
  containment: ProjectSkillContainment;
  skillFilePath: string;
}): Promise<void> {
  if (args.containment.kind === "none") {
    return;
  }

  if (args.containment.kind === "local") {
    await ensurePathContained(args.containment.root, args.skillFilePath, {
      allowMissing: true,
    });
    return;
  }

  await ensureRuntimePathWithinWorkspace(
    args.runtime,
    args.containment.root,
    args.skillFilePath,
    "Project skill file"
  );
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
  options?: {
    roots?: AgentSkillsRoots;
    containment?: ProjectSkillContainment;
    projectContainmentRoot?: string | null;
    dedupeByName?: boolean;
    extensionSkills?: readonly ExtensionSkillSource[];
  }
): Promise<AgentSkillDescriptor[]> {
  if (!workspacePath) {
    throw new Error("discoverAgentSkills: workspacePath is required");
  }

  const roots = options?.roots ?? getDefaultAgentSkillsRoots(runtime, workspacePath);

  const containment = resolveProjectSkillContainment(options);
  const dedupeByName = options?.dedupeByName ?? true;

  const byName = new Map<SkillName, AgentSkillDescriptor>();
  const discoveredSkills: AgentSkillDescriptor[] = [];

  // Scan order encodes precedence: earlier roots win when names collide.
  const scans = buildScanCandidates(runtime, workspacePath, roots);

  for (const scan of scans) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await scan.runtime.resolvePath(scan.root);
    } catch (err) {
      log.warn(`Failed to resolve skills root ${scan.root}: ${getErrorMessage(err)}`);
      continue;
    }

    const directoryNames =
      scan.runtime instanceof RemoteRuntime
        ? await listSkillDirectoriesFromRuntime(scan.runtime, resolvedRoot, { cwd: workspacePath })
        : await listSkillDirectoriesFromLocalFs(resolvedRoot);

    for (const directoryNameRaw of directoryNames) {
      const nameParsed = SkillNameSchema.safeParse(directoryNameRaw);
      if (!nameParsed.success) {
        log.warn(`Skipping invalid skill directory name '${directoryNameRaw}' in ${resolvedRoot}`);
        continue;
      }

      const directoryName = nameParsed.data;

      if (dedupeByName && byName.has(directoryName)) {
        continue;
      }

      const skillDir = scan.runtime.normalizePath(directoryName, resolvedRoot);
      const skillFilePath = scan.runtime.normalizePath("SKILL.md", skillDir);

      if (scan.scope === "project") {
        try {
          await assertProjectSkillContained({
            runtime: scan.runtime,
            containment,
            skillFilePath,
          });
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) {
            continue;
          }

          log.warn(
            `Skipping escaped project skill '${directoryName}' at '${skillFilePath}' for containment kind '${containment.kind}': ${getErrorMessage(error)}`
          );
          continue;
        }
      }

      const descriptor = await readSkillDescriptorFromDir(
        scan.runtime,
        skillDir,
        directoryName,
        scan.scope
      );
      if (!descriptor) continue;

      if (dedupeByName) {
        // First discovered descriptor wins because duplicates are skipped above.
        byName.set(descriptor.name, descriptor);
      } else {
        discoveredSkills.push(descriptor);
      }
    }
  }

  // Extensions sit between user-authored (project/global) and built-in: a
  // project skill can shadow an extension skill of the same name (so users
  // keep editorial control), and an extension can shadow a built-in.
  for (const ext of options?.extensionSkills ?? []) {
    const parsed = SkillNameSchema.safeParse(ext.name);
    if (!parsed.success) {
      log.warn(`Skipping invalid extension skill name '${ext.name}'`);
      continue;
    }
    const descriptor: AgentSkillDescriptor = {
      name: parsed.data,
      description: ext.description || ext.name,
      scope: "extension",
      advertise: ext.advertise,
    };
    const validated = AgentSkillDescriptorSchema.safeParse(descriptor);
    if (!validated.success) {
      log.warn(`Invalid extension skill descriptor '${ext.name}': ${validated.error.message}`);
      continue;
    }
    if (dedupeByName) {
      if (!byName.has(validated.data.name)) {
        byName.set(validated.data.name, validated.data);
      }
      continue;
    }
    discoveredSkills.push(validated.data);
  }

  for (const builtIn of getBuiltInSkillDescriptors()) {
    if (dedupeByName) {
      // Built-ins are lowest precedence and are omitted when overridden by project/global/extension skills.
      if (!byName.has(builtIn.name)) {
        byName.set(builtIn.name, builtIn);
      }
      continue;
    }

    discoveredSkills.push(builtIn);
  }

  const skills = dedupeByName ? Array.from(byName.values()) : discoveredSkills;
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export interface DiscoverAgentSkillsDiagnosticsResult {
  skills: AgentSkillDescriptor[];
  invalidSkills: AgentSkillIssue[];
}

export async function discoverAgentSkillsDiagnostics(
  runtime: Runtime,
  workspacePath: string,
  options?: {
    roots?: AgentSkillsRoots;
    containment?: ProjectSkillContainment;
    projectContainmentRoot?: string | null;
    extensionSkills?: readonly ExtensionSkillSource[];
  }
): Promise<DiscoverAgentSkillsDiagnosticsResult> {
  if (!workspacePath) {
    throw new Error("discoverAgentSkillsDiagnostics: workspacePath is required");
  }

  const roots = options?.roots ?? getDefaultAgentSkillsRoots(runtime, workspacePath);

  const containment = resolveProjectSkillContainment(options);

  const byName = new Map<SkillName, AgentSkillDescriptor>();
  const invalidSkills: AgentSkillIssue[] = [];

  // Scan order encodes precedence: earlier roots win when names collide.
  const scans = buildScanCandidates(runtime, workspacePath, roots);

  for (const scan of scans) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await scan.runtime.resolvePath(scan.root);
    } catch (err) {
      log.warn(`Failed to resolve skills root ${scan.root}: ${getErrorMessage(err)}`);
      continue;
    }

    const directoryNames =
      scan.runtime instanceof RemoteRuntime
        ? await listSkillDirectoriesFromRuntime(scan.runtime, resolvedRoot, { cwd: workspacePath })
        : await listSkillDirectoriesFromLocalFs(resolvedRoot);

    for (const directoryNameRaw of directoryNames) {
      const nameParsed = SkillNameSchema.safeParse(directoryNameRaw);
      if (!nameParsed.success) {
        log.warn(`Skipping invalid skill directory name '${directoryNameRaw}' in ${resolvedRoot}`);
        invalidSkills.push({
          directoryName: directoryNameRaw,
          scope: scan.scope,
          displayPath: scan.runtime.normalizePath(directoryNameRaw, resolvedRoot),
          message: `Invalid skill directory name '${directoryNameRaw}'.`,
          hint: "Rename the directory to kebab-case (lowercase letters/numbers/hyphens).",
        });
        continue;
      }

      const directoryName = nameParsed.data;

      if (byName.has(directoryName)) {
        continue;
      }

      const skillDir = scan.runtime.normalizePath(directoryName, resolvedRoot);
      const skillFilePath = scan.runtime.normalizePath("SKILL.md", skillDir);

      if (scan.scope === "project") {
        try {
          await assertProjectSkillContained({
            runtime: scan.runtime,
            containment,
            skillFilePath,
          });
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) {
            continue;
          }

          invalidSkills.push({
            directoryName,
            scope: scan.scope,
            displayPath: skillFilePath,
            message: `Project skill path escapes containment root: ${getErrorMessage(error)}`,
            hint: "Move the skill directory back under the workspace root or remove the escaping symlink.",
          });
          continue;
        }
      }

      const descriptor = await readSkillDescriptorFromDir(
        scan.runtime,
        skillDir,
        directoryName,
        scan.scope,
        {
          invalidSkills,
        }
      );
      if (!descriptor) continue;

      // First discovered descriptor wins because duplicates are skipped above.
      byName.set(descriptor.name, descriptor);
    }
  }

  for (const ext of options?.extensionSkills ?? []) {
    const parsed = SkillNameSchema.safeParse(ext.name);
    if (!parsed.success) continue;
    if (byName.has(parsed.data)) continue;
    const descriptor: AgentSkillDescriptor = {
      name: parsed.data,
      description: ext.description || ext.name,
      scope: "extension",
      advertise: ext.advertise,
    };
    const validated = AgentSkillDescriptorSchema.safeParse(descriptor);
    if (validated.success) byName.set(validated.data.name, validated.data);
  }

  // Add built-in skills (lowest precedence - only if not overridden by project/global/extension)
  for (const builtIn of getBuiltInSkillDescriptors()) {
    if (!byName.has(builtIn.name)) {
      byName.set(builtIn.name, builtIn);
    }
  }

  const skills = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));

  const scopeOrder: Readonly<Record<AgentSkillScope, number>> = {
    project: 0,
    global: 1,
    extension: 2,
    "built-in": 3,
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
  sourceRuntime: Runtime | null;
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
    sourceRuntime: runtime,
  };
}

async function readExtensionSkillBody(bodyAbsolutePath: string): Promise<{
  content: string;
  byteSize: number;
}> {
  const linkStat = await fs.lstat(bodyAbsolutePath);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`Extension skill body cannot be a symlink: ${bodyAbsolutePath}`);
  }
  if (linkStat.isDirectory()) {
    throw new Error(`Extension skill body is a directory: ${bodyAbsolutePath}`);
  }
  if (!linkStat.isFile()) {
    throw new Error(`Extension skill body is not a regular file: ${bodyAbsolutePath}`);
  }

  const realPath = await fs.realpath(bodyAbsolutePath);
  if (path.normalize(realPath) !== path.normalize(bodyAbsolutePath)) {
    throw new Error(`Extension skill body escaped its validated path: ${bodyAbsolutePath}`);
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const nonBlock = fsConstants.O_NONBLOCK ?? 0;
  const handle = await fs.open(realPath, fsConstants.O_RDONLY | noFollow | nonBlock);
  try {
    const openedRealPath = await realpathOpenedFile(handle, realPath);
    if (path.normalize(openedRealPath) !== path.normalize(realPath)) {
      throw new Error(
        `Extension skill body opened outside its validated path: ${bodyAbsolutePath}`
      );
    }

    const stat = await handle.stat();
    if (stat.isDirectory()) {
      throw new Error(`Extension skill body is a directory: ${bodyAbsolutePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Extension skill body is not a regular file: ${bodyAbsolutePath}`);
    }
    const sizeValidation = validateFileSize({
      size: stat.size,
      modifiedTime: stat.mtime,
      isDirectory: stat.isDirectory(),
    });
    if (sizeValidation) {
      throw new Error(sizeValidation.error);
    }

    const content = await handle.readFile("utf8");
    const byteSize = Buffer.byteLength(content, "utf8");
    const readSizeValidation = validateFileSize({
      size: byteSize,
      modifiedTime: stat.mtime,
      isDirectory: false,
    });
    if (readSizeValidation) {
      throw new Error(readSizeValidation.error);
    }
    return { content, byteSize };
  } finally {
    await handle.close();
  }
}

export async function readAgentSkill(
  runtime: Runtime,
  workspacePath: string,
  name: SkillName,
  options?: {
    roots?: AgentSkillsRoots;
    containment?: ProjectSkillContainment;
    projectContainmentRoot?: string | null;
    extensionSkills?: readonly ExtensionSkillSource[];
  }
): Promise<ResolvedAgentSkill> {
  if (!workspacePath) {
    throw new Error("readAgentSkill: workspacePath is required");
  }

  const roots = options?.roots ?? getDefaultAgentSkillsRoots(runtime, workspacePath);

  const containment = resolveProjectSkillContainment(options);

  // Scan order encodes precedence: earlier roots win when names collide.
  const candidates = buildScanCandidates(runtime, workspacePath, roots);

  for (const candidate of candidates) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await candidate.runtime.resolvePath(candidate.root);
    } catch {
      continue;
    }

    const skillDir = candidate.runtime.normalizePath(name, resolvedRoot);
    const skillFilePath = candidate.runtime.normalizePath("SKILL.md", skillDir);

    if (candidate.scope === "project") {
      try {
        await assertProjectSkillContained({
          runtime: candidate.runtime,
          containment,
          skillFilePath,
        });
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          continue;
        }

        log.warn(
          `Skipping escaped project skill '${name}' at '${skillFilePath}' for containment kind '${containment.kind}': ${getErrorMessage(error)}`
        );
        continue;
      }
    }

    try {
      const stat = await candidate.runtime.stat(skillDir);
      if (!stat.isDirectory) continue;

      return await readAgentSkillFromDir(candidate.runtime, skillDir, name, candidate.scope);
    } catch {
      continue;
    }
  }

  // Extension-contributed skills sit between user-authored and built-in:
  // checked only after no project/global skill of the same name resolved.
  // The body lives on the host filesystem (extensions live alongside the
  // app, not inside the workspace runtime), so we read it directly via
  // node:fs and bypass the workspace runtime's containment rules.
  const extensionSkill = (options?.extensionSkills ?? []).find((s) => s.name === name);
  if (extensionSkill) {
    try {
      const { content, byteSize } = await readExtensionSkillBody(extensionSkill.bodyAbsolutePath);
      const parsed = content.startsWith("---")
        ? parseSkillMarkdown({
            content,
            byteSize,
            directoryName: name,
          })
        : {
            frontmatter: {
              name,
              description:
                extensionSkill.description.trim() ||
                extensionSkill.displayName.trim() ||
                extensionSkill.name,
              advertise: extensionSkill.advertise,
            },
            body: content,
          };
      const pkg: AgentSkillPackage = {
        scope: "extension",
        directoryName: name,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
      };
      const validated = AgentSkillPackageSchema.safeParse(pkg);
      if (!validated.success) {
        throw new Error(
          `Invalid extension skill package for '${name}': ${validated.error.message}`
        );
      }
      return {
        package: validated.data,
        skillDir: path.dirname(extensionSkill.bodyAbsolutePath),
        sourceRuntime: null,
      };
    } catch (error) {
      log.warn(`Skipping unavailable extension skill '${name}': ${getErrorMessage(error)}`);
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
      sourceRuntime: null,
    };
  }

  throw new Error(`Agent skill not found: ${name}`);
}
