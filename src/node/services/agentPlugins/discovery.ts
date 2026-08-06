import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { ensurePathContained, hasErrorCode } from "@/node/services/tools/skillFileUtils";
import {
  isValidAgentPluginName,
  validatePluginManifest,
  type AgentPluginManifest,
} from "./manifest";

/**
 * Agent Plugins 1.0.0 discovery (§4, §6).
 *
 * A plugin is an immediate child directory of a configured container directory
 * that holds a regular `plugin.json` file. Entries without a `plugin.json` are
 * skipped silently (containers may hold unrelated files, e.g. Codex drops
 * `marketplace.json` into `~/.agents/plugins`). Failure isolation is per §11.3:
 * one broken plugin never affects sibling plugins, and one broken component
 * (skills/ or mcp.json) never affects the plugin's other component.
 *
 * Local host filesystem only (v1): plugin containers are host paths, so
 * discovery uses node:fs directly rather than a Runtime.
 */

export type AgentPluginScope = "project" | "global";

export interface AgentPluginContainer {
  /** Absolute host path of the container directory (e.g. `<projectRoot>/.mux/plugins`). */
  path: string;
  scope: AgentPluginScope;
}

export interface AgentPluginInfo {
  name: string;
  scope: AgentPluginScope;
  /** Canonical (realpath) plugin root directory. */
  rootPath: string;
  /** Lexical container directory this plugin was discovered in (as configured). */
  containerPath: string;
  /** Directory entry name under the container (lexical, pre-realpath). */
  dirName: string;
  manifest: AgentPluginManifest;
  /** Canonical `skills/` directory; present only when it exists, is a directory, and stays inside the root (§6.2). */
  skillsDir?: string;
  /** Canonical `mcp.json` path; present only when it exists, is a regular file, and stays inside the root (§6.2). */
  mcpConfigPath?: string;
}

export interface AgentPluginDiagnostic {
  /** Path of the plugin directory (or offending component path) the diagnostic refers to. */
  path: string;
  scope: AgentPluginScope;
  severity: "warning" | "error";
  message: string;
}

export interface DiscoverAgentPluginsResult {
  plugins: AgentPluginInfo[];
  diagnostics: AgentPluginDiagnostic[];
}

async function listChildDirectories(containerPath: string): Promise<string[]> {
  try {
    const entries = await fsPromises.readdir(containerPath, { withFileTypes: true });
    // Include symlinks: a symlinked plugin directory is fine because its
    // realpath becomes the plugin root for all containment checks.
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // Missing/unreadable containers are not errors (§6.1).
    return [];
  }
}

/**
 * Resolve a component location inside the plugin root (§6.2):
 * - missing → absent (not an error)
 * - wrong filesystem kind or realpath escape → invalid (diagnostic), but only
 *   for that component
 * - otherwise → canonical path
 */
async function resolveComponentPath(args: {
  rootReal: string;
  relativePath: string;
  expectKind: "file" | "directory";
  componentLabel: string;
  scope: AgentPluginScope;
  diagnostics: AgentPluginDiagnostic[];
}): Promise<string | undefined> {
  const candidate = path.join(args.rootReal, args.relativePath);

  let canonical: string;
  try {
    canonical = await ensurePathContained(args.rootReal, candidate);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    const message = `${args.componentLabel} resolves outside the plugin root; ignoring this component: ${getErrorMessage(error)}`;
    log.warn(`Agent plugin ${args.rootReal}: ${message}`);
    args.diagnostics.push({
      path: candidate,
      scope: args.scope,
      severity: "error",
      message,
    });
    return undefined;
  }

  let stat;
  try {
    stat = await fsPromises.stat(canonical);
  } catch {
    return undefined;
  }

  const kindOk = args.expectKind === "file" ? stat.isFile() : stat.isDirectory();
  if (!kindOk) {
    const message = `${args.componentLabel} must be a ${args.expectKind === "file" ? "regular file" : "directory"}; ignoring this component`;
    log.warn(`Agent plugin ${args.rootReal}: ${message}`);
    args.diagnostics.push({
      path: candidate,
      scope: args.scope,
      severity: "error",
      message,
    });
    return undefined;
  }

  return canonical;
}

async function discoverPluginAt(args: {
  pluginDir: string;
  containerPath: string;
  dirName: string;
  scope: AgentPluginScope;
  diagnostics: AgentPluginDiagnostic[];
}): Promise<AgentPluginInfo | null> {
  const { pluginDir, scope, diagnostics } = args;

  const pushError = (targetPath: string, message: string): void => {
    log.warn(`Agent plugin ${pluginDir}: ${message}`);
    diagnostics.push({ path: targetPath, scope, severity: "error", message });
  };

  // The canonical plugin root anchors every §4.1 containment check.
  let rootReal: string;
  try {
    rootReal = await fsPromises.realpath(pluginDir);
  } catch {
    // Broken symlink / vanished entry: not a plugin.
    return null;
  }

  const manifestPath = path.join(rootReal, "plugin.json");
  let manifestReal: string;
  try {
    manifestReal = await ensurePathContained(rootReal, manifestPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      // No plugin.json → not a plugin (silent skip, e.g. Codex marketplace.json entries).
      return null;
    }

    pushError(
      manifestPath,
      `plugin.json resolves outside the plugin root: ${getErrorMessage(error)}`
    );
    return null;
  }

  let manifestStat;
  try {
    manifestStat = await fsPromises.stat(manifestReal);
  } catch {
    return null;
  }
  if (!manifestStat.isFile()) {
    // plugin.json of the wrong filesystem kind: not a plugin candidate.
    return null;
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(await fsPromises.readFile(manifestReal, "utf8")) as unknown;
  } catch (error) {
    pushError(manifestPath, `Failed to read plugin.json: ${getErrorMessage(error)}`);
    return null;
  }

  const validation = validatePluginManifest(rawManifest);
  if (!validation.ok) {
    const label =
      validation.reason === "unsupported-version"
        ? "Unsupported Agent Plugins version"
        : "Invalid plugin manifest";
    pushError(manifestPath, `${label}: ${validation.errors.join("; ")}`);
    return null;
  }

  for (const warning of validation.warnings) {
    log.debug(`Agent plugin ${pluginDir}: ${warning}`);
    diagnostics.push({ path: manifestPath, scope, severity: "warning", message: warning });
  }

  // Defensive: the validator guarantees a spec-valid name.
  if (!isValidAgentPluginName(validation.manifest.name)) {
    throw new Error(
      `discoverPluginAt: validated manifest has spec-invalid name '${validation.manifest.name}'`
    );
  }

  const skillsDir = await resolveComponentPath({
    rootReal,
    relativePath: "skills",
    expectKind: "directory",
    componentLabel: "skills/",
    scope,
    diagnostics,
  });

  const mcpConfigPath = await resolveComponentPath({
    rootReal,
    relativePath: "mcp.json",
    expectKind: "file",
    componentLabel: "mcp.json",
    scope,
    diagnostics,
  });

  return {
    name: validation.manifest.name,
    scope,
    rootPath: rootReal,
    containerPath: args.containerPath,
    dirName: args.dirName,
    manifest: validation.manifest,
    ...(skillsDir !== undefined ? { skillsDir } : {}),
    ...(mcpConfigPath !== undefined ? { mcpConfigPath } : {}),
  };
}

/**
 * Discover Agent Plugins in the given container directories.
 *
 * Containers are scanned in the given order; plugins within a container are
 * ordered alphabetically for determinism. Duplicate plugin names are NOT
 * deduplicated here — downstream consumers key on plugin root path (MCP) or
 * dedupe by skill name at their own precedence rules (skills).
 */
export async function discoverAgentPlugins(
  containers: AgentPluginContainer[]
): Promise<DiscoverAgentPluginsResult> {
  const plugins: AgentPluginInfo[] = [];
  const diagnostics: AgentPluginDiagnostic[] = [];

  const seenContainers = new Set<string>();
  for (const container of containers) {
    if (!path.isAbsolute(container.path)) {
      throw new Error(`discoverAgentPlugins: container path must be absolute: ${container.path}`);
    }
    if (seenContainers.has(container.path)) {
      continue;
    }
    seenContainers.add(container.path);

    for (const entryName of await listChildDirectories(container.path)) {
      const plugin = await discoverPluginAt({
        pluginDir: path.join(container.path, entryName),
        containerPath: container.path,
        dirName: entryName,
        scope: container.scope,
        diagnostics,
      });
      if (plugin) {
        plugins.push(plugin);
      }
    }
  }

  return { plugins, diagnostics };
}
