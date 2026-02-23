import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Runtime } from "@/node/runtime/Runtime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { getErrorMessage } from "@/common/utils/errors";
import { execBuffered, readFileString } from "@/node/utils/runtime/helpers";
import { shellQuote } from "@/node/runtime/backgroundCommands";

import {
  AgentDefinitionDescriptorSchema,
  AgentDefinitionFrontmatterSchema,
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

export const MAX_INHERITANCE_DEPTH = 10;

/**
 * Generate a unique visit key for cycle detection that distinguishes
 * same-name agents at different scopes (e.g., project/exec vs built-in/exec).
 */
export function agentVisitKey(id: AgentId, scope: AgentDefinitionScope): string {
  return `${id}:${scope}`;
}

/**
 * Compute the skipScopesAbove value when resolving a base agent.
 * If the base has the same ID as the current agent, skip the current scope
 * to allow project/global agents to extend built-ins of the same name.
 */
export function computeBaseSkipScope(
  baseId: AgentId,
  currentId: AgentId,
  currentScope: AgentDefinitionScope
): AgentDefinitionScope | undefined {
  return baseId === currentId ? currentScope : undefined;
}

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
 * Includes a legacy `disabled` flag (from ui.disabled) for debugging/logging only.
 * Filtering is applied at higher layers so Settings can surface opt-in agents.
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
    log.warn(`Failed to read agent definition ${filePath}: ${getErrorMessage(err)}`);
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
    const message = err instanceof AgentDefinitionParseError ? err.message : getErrorMessage(err);
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
      log.warn(`Failed to resolve agents root ${scan.root}: ${getErrorMessage(err)}`);
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

  // Return all discovered agents (including those disabled by front-matter).
  // Filtering is applied at higher layers (e.g., agents.list) so Settings can still surface opt-in agents.
  return Array.from(byId.values())
    .map((entry) => entry.descriptor)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ReadAgentDefinitionOptions {
  roots?: AgentDefinitionsRoots;
  /**
   * Skip scopes at or above this level when resolving.
   * Used for base resolution: when a project-scope agent has `base: exec`,
   * we skip project scope to find the global/built-in exec, avoiding self-reference.
   */
  skipScopesAbove?: AgentDefinitionScope;
}

const SCOPE_PRIORITY: AgentDefinitionScope[] = ["project", "global", "built-in"];

export async function readAgentDefinition(
  runtime: Runtime,
  workspacePath: string,
  agentId: AgentId,
  options?: ReadAgentDefinitionOptions
): Promise<AgentDefinitionPackage> {
  if (!workspacePath) {
    throw new Error("readAgentDefinition: workspacePath is required");
  }

  const roots = options?.roots ?? getDefaultAgentDefinitionsRoots(runtime, workspacePath);
  const skipScopesAbove = options?.skipScopesAbove;

  // Determine which scopes to skip based on skipScopesAbove
  const skipScopes = new Set<AgentDefinitionScope>();
  if (skipScopesAbove) {
    const skipIndex = SCOPE_PRIORITY.indexOf(skipScopesAbove);
    if (skipIndex !== -1) {
      // Skip this scope and all higher-priority scopes
      for (let i = 0; i <= skipIndex; i++) {
        skipScopes.add(SCOPE_PRIORITY[i]);
      }
    }
  }

  // Precedence: project overrides global overrides built-in.
  const candidates: Array<{ scope: Exclude<AgentDefinitionScope, "built-in">; root: string }> = [
    { scope: "project", root: roots.projectRoot },
    { scope: "global", root: roots.globalRoot },
  ];

  for (const candidate of candidates) {
    if (skipScopes.has(candidate.scope)) {
      continue;
    }

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

  if (!skipScopes.has("built-in")) {
    const builtIn = getBuiltInAgentDefinitions().find((pkg) => pkg.id === agentId);
    if (builtIn) {
      const validated = AgentDefinitionPackageSchema.safeParse(builtIn);
      if (!validated.success) {
        throw new Error(
          `Invalid built-in agent definition '${agentId}': ${validated.error.message}`
        );
      }
      return validated.data;
    }
  }

  throw new Error(`Agent definition not found: ${agentId}`);
}

/**
 * Resolve the effective system prompt body for an agent, including inherited content.
 *
 * By default (or with `prompt.append: true`), the agent's body is appended to its base's body.
 * Set `prompt.append: false` to replace the base body entirely.
 *
 * When resolving a base, we skip the current agent's scope to allow overriding built-ins:
 * - Project-scope `exec.md` with `base: exec` → resolves to global/built-in exec
 * - Global-scope `exec.md` with `base: exec` → resolves to built-in exec
 */
export async function resolveAgentBody(
  runtime: Runtime,
  workspacePath: string,
  agentId: AgentId,
  options?: { roots?: AgentDefinitionsRoots; skipScopesAbove?: AgentDefinitionScope }
): Promise<string> {
  const visited = new Set<string>();

  function mergeSkipScopesAbove(
    a: AgentDefinitionScope | undefined,
    b: AgentDefinitionScope | undefined
  ): AgentDefinitionScope | undefined {
    if (!a) {
      return b;
    }
    if (!b) {
      return a;
    }

    const aIndex = SCOPE_PRIORITY.indexOf(a);
    const bIndex = SCOPE_PRIORITY.indexOf(b);

    // Defensive fallback. (In practice, both should always be in SCOPE_PRIORITY.)
    if (aIndex === -1 || bIndex === -1) {
      return a;
    }

    return aIndex > bIndex ? a : b;
  }

  async function resolve(
    id: AgentId,
    depth: number,
    skipScopesAbove?: AgentDefinitionScope
  ): Promise<string> {
    if (depth > MAX_INHERITANCE_DEPTH) {
      throw new Error(
        `Agent inheritance depth exceeded for '${id}' (max: ${MAX_INHERITANCE_DEPTH})`
      );
    }

    const pkg = await readAgentDefinition(runtime, workspacePath, id, {
      roots: options?.roots,
      skipScopesAbove,
    });

    const visitKey = agentVisitKey(pkg.id, pkg.scope);
    if (visited.has(visitKey)) {
      throw new Error(`Circular agent inheritance detected: ${pkg.id} (${pkg.scope})`);
    }
    visited.add(visitKey);

    const baseId = pkg.frontmatter.base;
    const shouldAppend = pkg.frontmatter.prompt?.append !== false;

    if (!baseId || !shouldAppend) {
      return pkg.body;
    }

    const baseBody = await resolve(
      baseId,
      depth + 1,
      mergeSkipScopesAbove(skipScopesAbove, computeBaseSkipScope(baseId, id, pkg.scope))
    );
    const separator = baseBody.trim() && pkg.body.trim() ? "\n\n" : "";
    return `${baseBody}${separator}${pkg.body}`;
  }

  return resolve(agentId, 0, options?.skipScopesAbove);
}

function formatZodIssues(
  issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>
): string {
  return issues
    .map((issue) => {
      const issuePath =
        issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") : "<root>";
      return `${issuePath}: ${issue.message}`;
    })
    .join("; ");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepMergeAgentFrontmatter(
  base: unknown,
  overlay: unknown,
  path: readonly string[]
): unknown {
  // Inherit base when the overlay isn't specified.
  if (overlay === undefined) {
    return base;
  }

  const pathKey = path.join(".");
  if (
    Array.isArray(base) &&
    Array.isArray(overlay) &&
    (pathKey === "tools.add" || pathKey === "tools.remove")
  ) {
    // Tool layers are processed in order (base first, then child).
    return [...(base as unknown[]), ...(overlay as unknown[])];
  }

  if (isPlainObject(base) && isPlainObject(overlay)) {
    const merged: Record<string, unknown> = { ...base };

    for (const [key, overlayValue] of Object.entries(overlay)) {
      merged[key] = deepMergeAgentFrontmatter(merged[key], overlayValue, [...path, key]);
    }

    return merged;
  }

  // Primitive, array (non-tools), or mismatched types: overlay wins.
  return overlay;
}

/**
 * Resolve an agent's effective frontmatter by overlaying its base chain (base first, then child).
 *
 * Unlike prompt body inheritance, frontmatter inheritance is always applied when `base` is set.
 * This prevents same-name overrides (e.g. project exec.md with base: exec) from accidentally
 * dropping important base config like subagent.runnable or subagent.append_prompt.
 */
export async function resolveAgentFrontmatter(
  runtime: Runtime,
  workspacePath: string,
  agentId: AgentId,
  options?: { roots?: AgentDefinitionsRoots; skipScopesAbove?: AgentDefinitionScope }
): Promise<AgentDefinitionPackage["frontmatter"]> {
  if (!workspacePath) {
    throw new Error("resolveAgentFrontmatter: workspacePath is required");
  }

  const visited = new Set<string>();

  function mergeSkipScopesAbove(
    a: AgentDefinitionScope | undefined,
    b: AgentDefinitionScope | undefined
  ): AgentDefinitionScope | undefined {
    if (!a) {
      return b;
    }
    if (!b) {
      return a;
    }

    const aIndex = SCOPE_PRIORITY.indexOf(a);
    const bIndex = SCOPE_PRIORITY.indexOf(b);

    // Defensive fallback. (In practice, both should always be in SCOPE_PRIORITY.)
    if (aIndex === -1 || bIndex === -1) {
      return a;
    }

    // Prefer the scope that skips *more* (e.g. global skips project+global).
    return aIndex > bIndex ? a : b;
  }

  async function resolve(
    id: AgentId,
    depth: number,
    skipScopesAbove?: AgentDefinitionScope
  ): Promise<AgentDefinitionPackage["frontmatter"]> {
    if (depth > MAX_INHERITANCE_DEPTH) {
      throw new Error(
        `Agent inheritance depth exceeded for '${id}' (max: ${MAX_INHERITANCE_DEPTH})`
      );
    }

    const pkg = await readAgentDefinition(runtime, workspacePath, id, {
      roots: options?.roots,
      skipScopesAbove,
    });

    const visitKey = agentVisitKey(pkg.id, pkg.scope);
    if (visited.has(visitKey)) {
      throw new Error(`Circular agent inheritance detected: ${pkg.id} (${pkg.scope})`);
    }
    visited.add(visitKey);

    const baseId = pkg.frontmatter.base;
    if (!baseId) {
      return pkg.frontmatter;
    }

    const baseFrontmatter = await resolve(
      baseId,
      depth + 1,
      mergeSkipScopesAbove(skipScopesAbove, computeBaseSkipScope(baseId, id, pkg.scope))
    );

    const mergedRaw = deepMergeAgentFrontmatter(baseFrontmatter, pkg.frontmatter, []);
    const merged = AgentDefinitionFrontmatterSchema.safeParse(mergedRaw);
    if (!merged.success) {
      throw new Error(
        `Invalid merged frontmatter for '${id}': ${formatZodIssues(merged.error.issues)}`
      );
    }

    return merged.data;
  }

  return resolve(agentId, 0, options?.skipScopesAbove);
}
