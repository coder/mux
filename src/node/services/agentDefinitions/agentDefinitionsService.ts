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

// Re-export the shared inheritance utilities for backend use
export { agentHasTool, isPlanLike, isExecLike } from "@/common/utils/agentInheritance";

const MAX_INHERITANCE_DEPTH = 10;

const GLOBAL_AGENTS_ROOT = "~/.mux/agents";

function resolveUiSelectable(
  ui: { hidden?: boolean; selectable?: boolean; disabled?: boolean } | undefined
): boolean {
  if (!ui) {
    return true;
  }

  if (typeof ui.hidden === "boolean") {
    return !ui.hidden;
  }

  if (typeof ui.selectable === "boolean") {
    return ui.selectable;
  }

  return true;
}

function resolveUiDisabled(ui: { disabled?: boolean } | undefined): boolean {
  return ui?.disabled === true;
}

/**
 * Internal type for tracking agent definitions during discovery.
 * Includes the `disabled` flag which is used to filter agents but not exposed in the final result.
 */
interface AgentDiscoveryEntry {
  descriptor: AgentDefinitionDescriptor;
  disabled: boolean;
}

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

async function readAgentDescriptorFromFileWithDisabled(
  runtime: Runtime,
  filePath: string,
  agentId: AgentId,
  scope: Exclude<AgentDefinitionScope, "built-in">
): Promise<AgentDiscoveryEntry | null> {
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

    const uiSelectable = resolveUiSelectable(parsed.frontmatter.ui);
    const uiColor = parsed.frontmatter.ui?.color;
    const subagentRunnable = parsed.frontmatter.subagent?.runnable ?? false;
    const disabled = resolveUiDisabled(parsed.frontmatter.ui);

    const descriptor: AgentDefinitionDescriptor = {
      id: agentId,
      scope,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      uiSelectable,
      uiColor,
      subagentRunnable,
      base: parsed.frontmatter.base,
      aiDefaults: parsed.frontmatter.ai,
      tools: parsed.frontmatter.tools,
    };

    const validated = AgentDefinitionDescriptorSchema.safeParse(descriptor);
    if (!validated.success) {
      log.warn(`Invalid agent definition descriptor for ${agentId}: ${validated.error.message}`);
      return null;
    }

    return { descriptor: validated.data, disabled };
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

  const byId = new Map<AgentId, AgentDiscoveryEntry>();

  // Seed built-ins (lowest precedence).
  for (const pkg of getBuiltInAgentDefinitions()) {
    const uiSelectable = resolveUiSelectable(pkg.frontmatter.ui);
    const uiColor = pkg.frontmatter.ui?.color;
    const subagentRunnable = pkg.frontmatter.subagent?.runnable ?? false;
    const disabled = resolveUiDisabled(pkg.frontmatter.ui);

    byId.set(pkg.id, {
      descriptor: {
        id: pkg.id,
        scope: "built-in",
        name: pkg.frontmatter.name,
        description: pkg.frontmatter.description,
        uiSelectable,
        uiColor,
        subagentRunnable,
        base: pkg.frontmatter.base,
        aiDefaults: pkg.frontmatter.ai,
        tools: pkg.frontmatter.tools,
      },
      disabled,
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
      const result = await readAgentDescriptorFromFileWithDisabled(
        runtime,
        filePath,
        agentId,
        scan.scope
      );
      if (!result) continue;

      byId.set(agentId, result);
    }
  }

  // Filter out disabled agents and return only the descriptors
  return Array.from(byId.values())
    .filter((entry) => !entry.disabled)
    .map((entry) => entry.descriptor)
    .sort((a, b) => a.name.localeCompare(b.name));
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

/**
 * Resolve the effective system prompt body for an agent, including inherited content.
 *
 * When an agent has `prompt.append: true` and a `base` agent, this function:
 * 1. Recursively resolves the base agent's body
 * 2. Appends this agent's body to the resolved base body
 *
 * Without `prompt.append: true`, the agent's body replaces the base (default behavior).
 */
export async function resolveAgentBody(
  runtime: Runtime,
  workspacePath: string,
  agentId: AgentId,
  options?: { roots?: AgentDefinitionsRoots }
): Promise<string> {
  const visited = new Set<AgentId>();

  async function resolve(id: AgentId, depth: number): Promise<string> {
    if (depth > MAX_INHERITANCE_DEPTH) {
      throw new Error(
        `Agent inheritance depth exceeded for '${id}' (max: ${MAX_INHERITANCE_DEPTH})`
      );
    }

    if (visited.has(id)) {
      throw new Error(`Circular agent inheritance detected: ${id}`);
    }
    visited.add(id);

    const pkg = await readAgentDefinition(runtime, workspacePath, id, options);
    const baseId = pkg.frontmatter.base;
    const shouldAppend = pkg.frontmatter.prompt?.append === true;

    // No base or not appending: just return this agent's body
    if (!baseId || !shouldAppend) {
      return pkg.body;
    }

    // Resolve base body and append this agent's body
    const baseBody = await resolve(baseId, depth + 1);
    const separator = baseBody.trim() && pkg.body.trim() ? "\n\n" : "";
    return `${baseBody}${separator}${pkg.body}`;
  }

  return resolve(agentId, 0);
}
