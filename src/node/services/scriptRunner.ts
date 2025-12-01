import { type Runtime } from "@/node/runtime/Runtime";
import {
  getScriptPath,
  getScriptsDir,
  getLegacyScriptPath,
  getLegacyScriptsDir,
} from "@/utils/scripts/discovery";
import { createBashTool } from "@/node/services/tools/bash";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { Ok, Err, type Result } from "@/common/types/result";
import { type BashToolResult } from "@/common/types/tools";

/**
 * Result of a script execution.
 *
 * Semantics:
 * - stdout: Agent-visible output (sent to model as tool result)
 * - stderr: Frontend-only output (shown to user, not sent to model)
 */
export interface ScriptExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Raw execution result from the underlying bash tool */
  toolResult: BashToolResult;
}

/**
 * Execute a workspace script.
 * Reuses createBashTool internally for consistent execution handling.
 */
export interface RunScriptOptions {
  env?: Record<string, string>;
  secrets?: Record<string, string>;
  timeoutSecs?: number;
  abortSignal?: AbortSignal;
  overflowPolicy?: "truncate" | "tmpfile";
  /**
   * Optional persistent temp directory root (e.g., stream-scoped ~/.mux-tmp/<token>).
   * When provided, scriptRunner will place its temp files in a unique subdirectory inside
   * this root so overflow logs can survive until the stream-level cleanup runs.
   */
  persistentTempDir?: string;
}

/**
 * Execute a workspace script.
 * Reuses createBashTool internally for consistent execution handling.
 */
export async function runWorkspaceScript(
  runtime: Runtime,
  workspacePath: string,
  scriptName: string,
  args: string[],
  options: RunScriptOptions = {}
): Promise<Result<ScriptExecutionResult, string>> {
  const {
    env = {},
    secrets = {},
    timeoutSecs = 300,
    abortSignal,
    overflowPolicy = "truncate",
    persistentTempDir,
  } = options;

  // 1. Validate script name safely
  if (scriptName.includes("/") || scriptName.includes("\\") || scriptName.includes("..")) {
    return Err(
      `Invalid script name: ${scriptName}. Script names must not contain path separators.`
    );
  }

  // Resolve real paths to handle symlinks and prevent escape
  const canonicalScriptPath = getScriptPath(workspacePath, scriptName);
  const canonicalScriptsDir = getScriptsDir(workspacePath);

  const legacyScriptPath = getLegacyScriptPath(workspacePath, scriptName);
  const legacyScriptsDir = getLegacyScriptsDir(workspacePath);

  let resolvedScriptPath: string;
  let resolvedScriptsDir: string;

  try {
    // Try canonical path first
    const candidatePath = await runtime.resolvePath(canonicalScriptPath);
    await runtime.stat(candidatePath); // Throws if not exists
    resolvedScriptPath = candidatePath;
    resolvedScriptsDir = await runtime.resolvePath(canonicalScriptsDir);
  } catch {
    try {
      // Try legacy path fallback
      const candidateLegacyPath = await runtime.resolvePath(legacyScriptPath);
      await runtime.stat(candidateLegacyPath); // Throws if not exists
      resolvedScriptPath = candidateLegacyPath;
      resolvedScriptsDir = await runtime.resolvePath(legacyScriptsDir);
    } catch {
      // Both missing. Default to canonical so the error message later (in step 2)
      // correctly reports the canonical path as missing.
      resolvedScriptPath = await runtime.resolvePath(canonicalScriptPath);
      resolvedScriptsDir = await runtime.resolvePath(canonicalScriptsDir);
    }
  }

  // Use runtime-aware normalization on the RESOLVED paths
  const normalizedScriptPath = runtime.normalizePath(resolvedScriptPath, workspacePath);
  const normalizedScriptsDir = runtime.normalizePath(resolvedScriptsDir, workspacePath);

  // Determine separator from the normalized path itself
  const separator = normalizedScriptsDir.includes("\\") ? "\\" : "/";

  // Ensure strict path containment
  if (!normalizedScriptPath.startsWith(normalizedScriptsDir + separator)) {
    return Err(`Invalid script name: ${scriptName}. Script path escapes scripts directory.`);
  }

  // 2. Check existence (redundant if resolvePath succeeded, but good for specific error msg if it was a file/dir mismatch)
  try {
    const stat = await runtime.stat(resolvedScriptPath);
    if (stat.isDirectory) {
      return Err(`Script is a directory: ${scriptName}`);
    }
  } catch {
    return Err(
      `Script not found: .mux/scripts/${scriptName}. Create the script in your workspace and make it executable (chmod +x).`
    );
  }

  // 3. Prepare temporary environment for overflow handling
  // Create a temp directory for this execution context. When a persistent temp root is provided,
  // create a unique subdirectory inside it so overflow logs survive until stream cleanup.
  const normalizeForShell = (value: string): string => value.replace(/\\/g, "/");
  const escapeSingleQuotes = (value: string): string => value.replace(/'/g, "'\\''");

  const persistentBase =
    persistentTempDir && persistentTempDir.trim().length > 0
      ? normalizeForShell(persistentTempDir.trim()).replace(/\/+$/, "")
      : undefined;

  const tempDirCommand = persistentBase
    ? `mkdir -p '${escapeSingleQuotes(persistentBase)}' && mktemp -d '${escapeSingleQuotes(`${persistentBase}/script-XXXXXX`)}'`
    : "mktemp -d 2>/dev/null || mktemp -d -t 'mux-script'";

  const tempDirResult = await execBuffered(runtime, tempDirCommand, {
    cwd: workspacePath,
    timeout: 5,
  });

  if (tempDirResult.exitCode !== 0) {
    return Err(`Failed to prepare script environment: ${tempDirResult.stderr || "mkdir failed"}`);
  }

  const runtimeTempDir = tempDirResult.stdout.trim();
  if (!runtimeTempDir) {
    return Err("Failed to prepare script environment: runtime temp directory was empty");
  }

  let skipCleanup = false;
  let cleanupScheduled = false;
  const cleanupTempDir = (): void => {
    if (skipCleanup || cleanupScheduled) {
      return;
    }
    cleanupScheduled = true;
    const safeTempDir = runtimeTempDir.replace(/"/g, '\\"');
    void execBuffered(runtime, `rm -rf "${safeTempDir}"`, {
      cwd: workspacePath,
      timeout: 5,
    });
  };

  // 4. Build the command
  // Quote arguments safely - basic quote wrapping for bash
  const escapedArgs = args
    .map((arg) => {
      // Use single quotes for stronger escaping (preserves literals)
      // Replace ' with '\'' to safely break out and insert a literal quote
      const safeArg = arg.replace(/'/g, "'\\''");
      return `'${safeArg}'`;
    })
    .join(" ");

  // We use the scriptPath directly, but escape it safely using single quotes
  // to prevent shell injection (e.g. if script name contains quotes or backticks)
  // NOTE: We use the resolved path to ensure we run exactly what we validated
  const safeScriptPath = resolvedScriptPath.replace(/'/g, "'\\''");
  const command = `'${safeScriptPath}'${escapedArgs ? ` ${escapedArgs}` : ""}`;

  // 5. Execute using createBashTool
  const bashTool = createBashTool({
    cwd: workspacePath,
    runtime: runtime,
    secrets: secrets,
    runtimeTempDir,
    overflow_policy: overflowPolicy,
    env,
  });

  try {
    const toolResult = (await bashTool.execute!(
      {
        script: command,
        timeout_secs: timeoutSecs,
      },
      {
        toolCallId: `script-${scriptName}-${Date.now()}`,
        messages: [],
        abortSignal,
      }
    )) as BashToolResult;

    // 6. Handle cleanup for overflow cases
    const indicatesTmpfileOverflow =
      Boolean(persistentBase) &&
      overflowPolicy === "tmpfile" &&
      !toolResult.success &&
      typeof toolResult.error === "string" &&
      toolResult.error.includes("[OUTPUT OVERFLOW -");

    if (indicatesTmpfileOverflow) {
      skipCleanup = true;
    } else {
      cleanupTempDir();
    }

    // Extract stdout/stderr based on success/failure
    let stdout = "";
    let stderr = "";

    if (toolResult.success) {
      stdout = toolResult.output;
    } else {
      stdout = toolResult.output ?? ""; // Sometimes output is present even on failure
      stderr = toolResult.error;
    }

    return Ok({
      exitCode: toolResult.exitCode,
      stdout,
      stderr,
      toolResult,
    });
  } catch (execError) {
    cleanupTempDir();
    return Err(
      `Script execution failed: ${execError instanceof Error ? execError.message : String(execError)}`
    );
  }
}
