import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Runtime } from "@/node/runtime/Runtime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { execBuffered, readFileString } from "@/node/utils/runtime/helpers";
import { shellQuote } from "@/node/runtime/backgroundCommands";

import {
  AgentDefinitionDescriptorSchema,
  AgentDefinitionPackageSchema,
  AgentIdSchema,
} from "@/common/orpc/schemas";
import type {
  AgentDefinitionDescriptor,
  AgentDefinitionPackage,
  AgentDefinitionScope,
  AgentId,
} from "@/common/types/agentDefinition";
import { log } from "@/node/services/log";
import { validateFileSize } from "@/node/services/tools/fileCommon";

import { getBuiltInAgentDefinitions } from "./builtInAgentDefinitions";
import {
  AgentDefinitionParseError,
  parseAgentDefinitionMarkdown,
} from "./parseAgentDefinitionMarkdown";

const GLOBAL_AGENTS_ROOT = "~/.mux/agents";

export interface AgentDefinitionsRoots {
  projectRoot: string;
  globalRoot: string;
}

export function getDefaultAgentDefinitionsRoots(
  runtime: Runtime,
  workspacePath: string
): AgentDefinitionsRoots {
  if (!workspacePath) {
    throw new Error("getDefaultAgentDefinitionsRoots: workspacePath is required");
  }

  return {
    projectRoot: runtime.normalizePath(".mux/agents", workspacePath),
    globalRoot: GLOBAL_AGENTS_ROOT,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function listAgentFilesFromLocalFs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listAgentFilesFromRuntime(
  runtime: Runtime,
  root: string,
  options: { cwd: string }
): Promise<string[]> {
  if (!options.cwd) {
    throw new Error("listAgentFilesFromRuntime: options.cwd is required");
  }

  const quotedRoot = shellQuote(root);
  const command =
    `if [ -d ${quotedRoot} ]; then ` +
    `find ${quotedRoot} -mindepth 1 -maxdepth 1 -type f -name '*.md' -exec basename {} \\; ; ` +
    `fi`;

  const result = await execBuffered(runtime, command, { cwd: options.cwd, timeout: 10 });
  if (result.exitCode !== 0) {
    log.warn(`Failed to read agents directory ${root}: ${result.stderr || result.stdout}`);
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function getAgentIdFromFilename(filename: string): AgentId | null {
  const parsed = path.parse(filename);
  if (parsed.ext.toLowerCase() !== ".md") {
    return null;
  }

  const idRaw = parsed.name.trim().toLowerCase();
  const idParsed = AgentIdSchema.safeParse(idRaw);
  if (!idParsed.success) {
    return null;
  }

  return idParsed.data;
}

async function readAgentDescriptorFromFile(
  runtime: Runtime,
  filePath: string,
  agentId: AgentId,
  scope: Exclude<AgentDefinitionScope, "built-in">
): Promise<AgentDefinitionDescriptor | null> {
  let stat;
  try {
    stat = await runtime.stat(filePath);
  } catch {
    return null;
  }

  if (stat.isDirectory) {
    return null;
  }

  const sizeValidation = validateFileSize(stat);
  if (sizeValidation) {
    log.warn(`Skipping agent '${agentId}' (${scope}): ${sizeValidation.error}`);
    return null;
  }

  let content: string;
  try {
    content = await readFileString(runtime, filePath);
  } catch (err) {
    log.warn(`Failed to read agent definition ${filePath}: ${formatError(err)}`);
    return null;
  }

  try {
    const parsed = parseAgentDefinitionMarkdown({ content, byteSize: stat.size });

    const uiSelectable = parsed.frontmatter.ui?.selectable ?? false;
    const subagentRunnable = parsed.frontmatter.subagent?.runnable ?? false;
    const policyBase = parsed.frontmatter.policy?.base ?? "exec";

    const descriptor: AgentDefinitionDescriptor = {
      id: agentId,
      scope,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      uiSelectable,
      subagentRunnable,
      policyBase,
      aiDefaults: parsed.frontmatter.ai,
      toolFilter: parsed.frontmatter.policy?.tools,
    };

    const validated = AgentDefinitionDescriptorSchema.safeParse(descriptor);
    if (!validated.success) {
      log.warn(`Invalid agent definition descriptor for ${agentId}: ${validated.error.message}`);
      return null;
    }

    return validated.data;
  } catch (err) {
    const message = err instanceof AgentDefinitionParseError ? err.message : formatError(err);
    log.warn(`Skipping invalid agent definition '${agentId}' (${scope}): ${message}`);
    return null;
  }
}

export async function discoverAgentDefinitions(
  runtime: Runtime,
  workspacePath: string,
  options?: { roots?: AgentDefinitionsRoots }
): Promise<AgentDefinitionDescriptor[]> {
  if (!workspacePath) {
    throw new Error("discoverAgentDefinitions: workspacePath is required");
  }

  const roots = options?.roots ?? getDefaultAgentDefinitionsRoots(runtime, workspacePath);

  const byId = new Map<AgentId, AgentDefinitionDescriptor>();

  // Seed built-ins (lowest precedence).
  for (const pkg of getBuiltInAgentDefinitions()) {
    const uiSelectable = pkg.frontmatter.ui?.selectable ?? false;
    const subagentRunnable = pkg.frontmatter.subagent?.runnable ?? false;
    const policyBase = pkg.frontmatter.policy?.base ?? "exec";

    byId.set(pkg.id, {
      id: pkg.id,
      scope: "built-in",
      name: pkg.frontmatter.name,
      description: pkg.frontmatter.description,
      uiSelectable,
      subagentRunnable,
      policyBase,
      aiDefaults: pkg.frontmatter.ai,
      toolFilter: pkg.frontmatter.policy?.tools,
    });
  }

  const scans: Array<{ scope: Exclude<AgentDefinitionScope, "built-in">; root: string }> = [
    { scope: "global", root: roots.globalRoot },
    { scope: "project", root: roots.projectRoot },
  ];

  for (const scan of scans) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await runtime.resolvePath(scan.root);
    } catch (err) {
      log.warn(`Failed to resolve agents root ${scan.root}: ${formatError(err)}`);
      continue;
    }

    const filenames =
      runtime instanceof SSHRuntime
        ? await listAgentFilesFromRuntime(runtime, resolvedRoot, { cwd: workspacePath })
        : await listAgentFilesFromLocalFs(resolvedRoot);

    for (const filename of filenames) {
      const agentId = getAgentIdFromFilename(filename);
      if (!agentId) {
        log.warn(`Skipping invalid agent filename '${filename}' in ${resolvedRoot}`);
        continue;
      }

      const filePath = runtime.normalizePath(filename, resolvedRoot);
      const descriptor = await readAgentDescriptorFromFile(runtime, filePath, agentId, scan.scope);
      if (!descriptor) continue;

      byId.set(agentId, descriptor);
    }
  }

  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function readAgentDefinition(
  runtime: Runtime,
  workspacePath: string,
  agentId: AgentId,
  options?: { roots?: AgentDefinitionsRoots }
): Promise<AgentDefinitionPackage> {
  if (!workspacePath) {
    throw new Error("readAgentDefinition: workspacePath is required");
  }

  const roots = options?.roots ?? getDefaultAgentDefinitionsRoots(runtime, workspacePath);

  // Precedence: project overrides global overrides built-in.
  const candidates: Array<{ scope: Exclude<AgentDefinitionScope, "built-in">; root: string }> = [
    { scope: "project", root: roots.projectRoot },
    { scope: "global", root: roots.globalRoot },
  ];

  for (const candidate of candidates) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await runtime.resolvePath(candidate.root);
    } catch {
      continue;
    }

    const filePath = runtime.normalizePath(`${agentId}.md`, resolvedRoot);

    try {
      const stat = await runtime.stat(filePath);
      if (stat.isDirectory) {
        continue;
      }

      const sizeValidation = validateFileSize(stat);
      if (sizeValidation) {
        throw new Error(sizeValidation.error);
      }

      const content = await readFileString(runtime, filePath);
      const parsed = parseAgentDefinitionMarkdown({ content, byteSize: stat.size });

      const pkg: AgentDefinitionPackage = {
        id: agentId,
        scope: candidate.scope,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
      };

      const validated = AgentDefinitionPackageSchema.safeParse(pkg);
      if (!validated.success) {
        throw new Error(
          `Invalid agent definition package for '${agentId}' (${candidate.scope}): ${validated.error.message}`
        );
      }

      return validated.data;
    } catch {
      continue;
    }
  }

  const builtIn = getBuiltInAgentDefinitions().find((pkg) => pkg.id === agentId);
  if (builtIn) {
    const validated = AgentDefinitionPackageSchema.safeParse(builtIn);
    if (!validated.success) {
      throw new Error(`Invalid built-in agent definition '${agentId}': ${validated.error.message}`);
    }
    return validated.data;
  }

  throw new Error(`Agent definition not found: ${agentId}`);
}
