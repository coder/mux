import type { Runtime, ExecOptions } from "@/node/runtime/Runtime";
import { PlatformPaths } from "@/node/utils/paths.main";
import { getLegacyPlanFilePath, getPlanFilePath } from "@/common/utils/planStorage";

/**
 * Convenience helpers for working with streaming Runtime APIs.
 * These provide simple string-based APIs on top of the low-level streaming primitives.
 */

/**
 * Extract project name from a project path
 * Works for both local paths and remote paths
 */
export function getProjectName(projectPath: string): string {
  return PlatformPaths.getProjectName(projectPath);
}

/**
 * Result from executing a command with buffered output
 */
export interface ExecResult {
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Exit code (0 = success) */
  exitCode: number;
  /** Wall clock duration in milliseconds */
  duration: number;
}

/**
 * Execute a command and buffer all output into strings
 */
export async function execBuffered(
  runtime: Runtime,
  command: string,
  options: ExecOptions & { stdin?: string }
): Promise<ExecResult> {
  const stream = await runtime.exec(command, options);

  // Write stdin if provided
  if (options.stdin !== undefined) {
    const writer = stream.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(options.stdin));
      await writer.close();
    } catch (err) {
      writer.releaseLock();
      throw err;
    }
  } else {
    // Close stdin immediately if no input
    await stream.stdin.close();
  }

  // Read stdout and stderr concurrently
  const [stdout, stderr, exitCode, duration] = await Promise.all([
    streamToString(stream.stdout),
    streamToString(stream.stderr),
    stream.exitCode,
    stream.duration,
  ]);

  return { stdout, stderr, exitCode, duration };
}

/**
 * Read file contents as a UTF-8 string
 */
export async function readFileString(
  runtime: Runtime,
  path: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const stream = runtime.readFile(path, abortSignal);
  return streamToString(stream);
}

/**
 * Write string contents to a file atomically
 */
export async function writeFileString(
  runtime: Runtime,
  path: string,
  content: string,
  abortSignal?: AbortSignal
): Promise<void> {
  const stream = runtime.writeFile(path, abortSignal);
  const writer = stream.getWriter();
  try {
    await writer.write(new TextEncoder().encode(content));
    await writer.close();
  } catch (err) {
    writer.releaseLock();
    throw err;
  }
}

/**
 * Convert a ReadableStream<Uint8Array> to a UTF-8 string
 */
async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let result = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    // Final flush
    result += decoder.decode();
    return result;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Result from reading a plan file with legacy migration support
 */
export interface ReadPlanResult {
  /** Plan file content (empty string if file doesn't exist) */
  content: string;
  /** Whether a plan file exists */
  exists: boolean;
  /** The canonical plan file path (new format) */
  path: string;
}

/**
 * Read plan file content, checking new path first then legacy, migrating if needed.
 * This handles the transparent migration from ~/.mux/plans/{id}.md to
 * ~/.mux/plans/{projectName}/{workspaceName}.md
 */
export async function readPlanFile(
  runtime: Runtime,
  workspaceName: string,
  projectName: string,
  workspaceId: string
): Promise<ReadPlanResult> {
  const planPath = getPlanFilePath(workspaceName, projectName);
  const legacyPath = getLegacyPlanFilePath(workspaceId);

  // Resolve tilde to absolute path for client use (editor deep links, etc.)
  // For local runtimes this expands ~ to /home/user; for SSH it resolves remotely
  const resolvedPath = await runtime.resolvePath(planPath);

  // Try new path first
  try {
    const content = await readFileString(runtime, planPath);
    return { content, exists: true, path: resolvedPath };
  } catch {
    // Fall back to legacy path
    try {
      const content = await readFileString(runtime, legacyPath);
      // Migrate: move to new location
      try {
        const planDir = planPath.substring(0, planPath.lastIndexOf("/"));
        await execBuffered(runtime, `mkdir -p "${planDir}" && mv "${legacyPath}" "${planPath}"`, {
          cwd: "/tmp",
          timeout: 5,
        });
      } catch {
        // Migration failed, but we have the content
      }
      return { content, exists: true, path: resolvedPath };
    } catch {
      // File doesn't exist at either location
      return { content: "", exists: false, path: resolvedPath };
    }
  }
}

/**
 * Move a plan file from one workspace name to another (e.g., during rename).
 * Silently succeeds if source file doesn't exist.
 */
export async function movePlanFile(
  runtime: Runtime,
  oldWorkspaceName: string,
  newWorkspaceName: string,
  projectName: string
): Promise<void> {
  const oldPath = getPlanFilePath(oldWorkspaceName, projectName);
  const newPath = getPlanFilePath(newWorkspaceName, projectName);

  try {
    await runtime.stat(oldPath);
    // Resolve tildes to absolute paths - bash doesn't expand ~ inside quotes
    const resolvedOldPath = await runtime.resolvePath(oldPath);
    const resolvedNewPath = await runtime.resolvePath(newPath);
    await execBuffered(runtime, `mv "${resolvedOldPath}" "${resolvedNewPath}"`, {
      cwd: "/tmp",
      timeout: 5,
    });
  } catch {
    // No plan file to move, that's fine
  }
}

/**
 * Copy a plan file from one workspace to another (e.g., during fork).
 * Checks both new path format and legacy path format for the source.
 * Silently succeeds if source file doesn't exist at either location.
 */
export async function copyPlanFile(
  runtime: Runtime,
  sourceWorkspaceName: string,
  sourceWorkspaceId: string,
  targetWorkspaceName: string,
  projectName: string
): Promise<void> {
  const sourcePath = getPlanFilePath(sourceWorkspaceName, projectName);
  const legacySourcePath = getLegacyPlanFilePath(sourceWorkspaceId);
  const targetPath = getPlanFilePath(targetWorkspaceName, projectName);

  // Prefer the new layout, but fall back to the legacy layout.
  //
  // Note: we intentionally use runtime file I/O instead of `cp` because:
  // 1) bash doesn't expand ~ inside quotes
  // 2) the target per-project plan directory may not exist yet
  // 3) runtime.writeFile() already handles directory creation + tilde expansion
  for (const candidatePath of [sourcePath, legacySourcePath]) {
    try {
      const content = await readFileString(runtime, candidatePath);
      await writeFileString(runtime, targetPath, content);
      return;
    } catch {
      // Try next candidate
    }
  }
}
