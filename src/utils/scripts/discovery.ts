import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";

/**
 * Information about a discovered script
 */
export interface ScriptInfo {
  /** Script filename (e.g., "deploy") */
  name: string;
  /** Optional description extracted from script comments */
  description?: string;
  /** Whether the script is executable */
  isExecutable: boolean;
}

// Cache configuration
const CACHE_TTL_MS = 5000;
interface CacheEntry {
  timestamp: number;
  data: ScriptInfo[];
  promise?: Promise<ScriptInfo[]>;
}

const scriptCache = new WeakMap<Runtime, Map<string, CacheEntry>>();

/**
 * List all scripts in .cmux/scripts/ directory for a workspace
 * @param runtime - Runtime to use for listing scripts (supports local and SSH)
 * @param workspacePath - Path to the workspace directory
 * @returns Array of script information, sorted by name
 */
export async function listScripts(runtime: Runtime, workspacePath: string): Promise<ScriptInfo[]> {
  const now = Date.now();

  let runtimeCache = scriptCache.get(runtime);
  if (!runtimeCache) {
    runtimeCache = new Map();
    scriptCache.set(runtime, runtimeCache);
  }

  const cached = runtimeCache.get(workspacePath);

  // Return cached data if valid
  if (cached && now - cached.timestamp < CACHE_TTL_MS && !cached.promise) {
    return cached.data;
  }

  // Return in-flight promise if exists (coalescing)
  if (cached?.promise) {
    return cached.promise;
  }

  // Create new discovery promise
  const discoveryPromise = (async () => {
    try {
      const scripts = await discoverScriptsInternal(runtime, workspacePath);
      runtimeCache.set(workspacePath, {
        timestamp: Date.now(),
        data: scripts,
        promise: undefined,
      });
      return scripts;
    } catch {
      // On error, keep old cache if it exists, otherwise clear
      if (cached) {
        // Reset promise so next try can happen, but keep old data for now
        cached.promise = undefined;
        return cached.data;
      }
      runtimeCache.delete(workspacePath);
      return [];
    }
  })();

  // Store promise in cache
  runtimeCache.set(workspacePath, {
    timestamp: cached?.timestamp ?? 0,
    data: cached?.data ?? [],
    promise: discoveryPromise,
  });

  return discoveryPromise;
}

async function discoverScriptsInternal(
  runtime: Runtime,
  workspacePath: string
): Promise<ScriptInfo[]> {
  const scriptsDir = getScriptsDir(workspacePath);
  // Unique separator unlikely to appear in filenames or output
  const separator = ":::MUX_SCRIPT_START:::";

  // Single command to find, check executable status, and read headers of all scripts
  // 1. Check if directory exists
  // 2. Loop through files
  // 3. Print separator + filename
  // 4. Print executable status
  // 5. Print first 20 lines (for description extraction)
  // Note: We quote paths to prevent shell injection
  const safeScriptsDir = scriptsDir.replace(/'/g, "'\\''");
  const command = `
    if [ -d '${safeScriptsDir}' ]; then
      for f in '${safeScriptsDir}'/*; do
        [ -f "$f" ] || continue
        echo "${separator}$(basename "$f")"
        if [ -x "$f" ]; then echo "IS_EXECUTABLE:1"; else echo "IS_EXECUTABLE:0"; fi
        head -n 20 "$f" 2>/dev/null
      done
    fi
  `;

  try {
    const result = await execBuffered(runtime, command, {
      cwd: workspacePath,
      timeout: 5,
    });

    if (result.exitCode !== 0 && result.stdout.trim() === "") {
      return [];
    }

    const output = result.stdout;
    if (!output.trim()) {
      return [];
    }

    const scripts: ScriptInfo[] = [];
    const parts = output.split(separator);

    // First part is empty or garbage before first separator
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const lines = part.split("\n");
      if (lines.length === 0) continue;

      const filename = lines[0].trim();
      if (!filename) continue;

      // Find executable status
      let isExecutable = false;
      let contentStartLine = 1;

      if (lines.length > 1 && lines[1].startsWith("IS_EXECUTABLE:")) {
        isExecutable = lines[1].trim() === "IS_EXECUTABLE:1";
        contentStartLine = 2;
      }

      // Extract content for description (skip filename and status lines)
      const content = lines.slice(contentStartLine).join("\n");
      const description = extractDescriptionFromContent(content);

      scripts.push({
        name: filename,
        description,
        isExecutable,
      });
    }

    return scripts.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Extract description from script content by parsing first comment lines
 * Looks for patterns like:
 * - # Description: <text>
 * - # @description <text> (tool-style)
 * - # <text> (first comment line)
 * @param content - Script file content
 * @returns Description text or undefined
 */
function extractDescriptionFromContent(content: string): string | undefined {
  const lines = content.split("\n").slice(0, 20); // Check first 20 lines

  for (const line of lines) {
    // Look for "# Description: ..." format (allowing leading whitespace)
    const descMatch = /^\s*#\s*Description:\s*(.+)$/i.exec(line);
    if (descMatch) {
      return descMatch[1].trim();
    }

    // Look for "# @description ..." format (tool-style, allowing leading whitespace)
    const toolDescMatch = /^\s*#\s*@description\s+(.+)$/i.exec(line);
    if (toolDescMatch) {
      return toolDescMatch[1].trim();
    }
  }

  // Fallback: use first comment line that's not shebang
  for (const line of lines) {
    if (line.startsWith("#!")) {
      continue; // Skip shebang
    }

    const commentMatch = /^#\s*(.+)$/.exec(line);
    if (commentMatch) {
      const text = commentMatch[1].trim();
      if (text.length > 0 && text.length < 100) {
        return text;
      }
    }

    // Stop at first non-comment line
    if (line.trim().length > 0 && !line.startsWith("#")) {
      break;
    }
  }

  return undefined;
}

/**
 * Join paths respecting the workspace path style (POSIX vs Windows).
 * On Windows, path.join converts everything to backslashes.
 * If workspacePath looks like POSIX (has forward slashes, no backslashes), use path.posix.
 */
function joinWorkspacePath(workspacePath: string, ...parts: string[]): string {
  const isPosix = workspacePath.includes("/") && !workspacePath.includes("\\");
  if (isPosix) {
    return path.posix.join(workspacePath, ...parts);
  }
  return path.join(workspacePath, ...parts);
}

/**
 * Get the scripts directory path
 * @param workspacePath - Path to the workspace directory
 * @returns Path to scripts directory
 */
export function getScriptsDir(workspacePath: string): string {
  return joinWorkspacePath(workspacePath, ".cmux", "scripts");
}

/**
 * Get the full path to a script
 * @param workspacePath - Path to the workspace directory
 * @param scriptName - Name of the script file
 * @returns Full path to script
 */
export function getScriptPath(workspacePath: string, scriptName: string): string {
  return joinWorkspacePath(workspacePath, ".cmux", "scripts", scriptName);
}

/**
 * Check if a script exists and is executable
 * @param workspacePath - Path to the workspace directory
 * @param scriptName - Name of the script file
 * @returns true if script exists and is executable
 */
export async function checkScriptExecutable(
  workspacePath: string,
  scriptName: string
): Promise<boolean> {
  const scriptPath = getScriptPath(workspacePath, scriptName);

  try {
    await fsPromises.access(scriptPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
