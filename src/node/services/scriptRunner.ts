import * as path from "path";
import { type Runtime } from "@/node/runtime/Runtime";
import { getScriptPath, getScriptsDir } from "@/utils/scripts/discovery";
import { createBashTool } from "@/node/services/tools/bash";
import { writeFileString, readFileString, execBuffered } from "@/node/utils/runtime/helpers";
import { Ok, Err, type Result } from "@/common/types/result";
import { type BashToolResult } from "@/common/types/tools";

/**
 * Result of a script execution, including standard output/error and special MUX file contents
 */
export interface ScriptExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Content written to MUX_OUTPUT (for user toasts) */
  outputFileContent?: string;
  /** Content written to MUX_PROMPT (for agent prompts) */
  promptFileContent?: string;
  /** Raw execution result from the underlying bash tool */
  toolResult: BashToolResult;
}

/**
 * Execute a workspace script with full environment setup (MUX_OUTPUT, MUX_PROMPT, etc.)
 * Reuses the robust createBashTool internally for consistent execution handling.
 */
export interface RunScriptOptions {
  env?: Record<string, string>;
  secrets?: Record<string, string>;
  timeoutSecs?: number;
  abortSignal?: AbortSignal;
  overflowPolicy?: "truncate" | "tmpfile";
}

/**
 * Execute a workspace script with full environment setup (MUX_OUTPUT, MUX_PROMPT, etc.)
 * Reuses the robust createBashTool internally for consistent execution handling.
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
  } = options;

  // 1. Validate script name safely
  if (scriptName.includes("/") || scriptName.includes("\\") || scriptName.includes("..")) {
    return Err(
      `Invalid script name: ${scriptName}. Script names must not contain path separators.`
    );
  }

  // Resolve real paths to handle symlinks and prevent escape
  const scriptPath = getScriptPath(workspacePath, scriptName);
  const scriptsDir = getScriptsDir(workspacePath);

  let resolvedScriptPath: string;
  let resolvedScriptsDir: string;

  try {
    // Use runtime.resolvePath (which should behave like realpath) if available,
    // otherwise rely on the runtime-specific normalization.
    // Ideally, we want `realpath` behavior here.
    // Since the Runtime interface doesn't strictly expose `realpath`, we'll rely on
    // the filesystem (via runtime.exec or similar) or assume normalizePath+standard checks are mostly sufficient.
    // HOWEVER, for local runtime we can use fs.realpath. For SSH, we might need a command.
    // To keep it simple and robust within the existing abstractions:
    // We will use the runtime to resolve the path if possible, but `runtime.resolvePath`
    // is documented to expand tildes, not necessarily resolve symlinks (though it often does).

    // BUT, to address the specific review concern about symlinks:
    // We should try to get the canonical path.
    // Note: checking containment purely by string path on un-resolved paths is weak against symlinks.

    // Strategy:
    // 1. Get the script path (constructed from workspace + script name).
    // 2. Get the scripts dir.
    // 3. Ask runtime to resolve them to absolute, canonical paths (resolving symlinks).
    //    (If runtime doesn't support explicit symlink resolution in its API, we might be limited).
    //    The review implies we *should* do this.
    //    Let's add a helper or use `runtime.resolvePath` which claims to resolve to "absolute, canonical form".

    resolvedScriptPath = await runtime.resolvePath(scriptPath);
    resolvedScriptsDir = await runtime.resolvePath(scriptsDir);
  } catch {
    // If we can't resolve paths (e.g. file doesn't exist), we can't verify containment securely.
    // But we already established the script *must* exist in step 2 (which we moved up or will do).
    // Actually step 2 is below. Let's do existence check + resolution together or accept that
    // resolution failure implies non-existence.
    return Err(`Script not found or inaccessible: ${scriptName}`);
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
      return Err(`Script not found: .cmux/scripts/${scriptName}`);
    }
  } catch {
    return Err(
      `Script not found: .cmux/scripts/${scriptName}. Create the script in your workspace and make it executable (chmod +x).`
    );
  }

  // 3. Prepare temporary environment (MUX_OUTPUT, MUX_PROMPT)
  // Create a temp directory for this execution context
  const tempDirResult = await execBuffered(
    runtime,
    "mktemp -d 2>/dev/null || mktemp -d -t 'mux-script'",
    { cwd: workspacePath, timeout: 5 }
  );

  if (tempDirResult.exitCode !== 0) {
    return Err(`Failed to prepare script environment: ${tempDirResult.stderr || "mkdir failed"}`);
  }

  const runtimeTempDir = tempDirResult.stdout.trim();
  if (!runtimeTempDir) {
    return Err("Failed to prepare script environment: runtime temp directory was empty");
  }

  const outputFile = path.posix.join(runtimeTempDir, "output.txt");
  const promptFile = path.posix.join(runtimeTempDir, "prompt.txt");

  try {
    await writeFileString(runtime, outputFile, "");
    await writeFileString(runtime, promptFile, "");
  } catch (prepError) {
    return Err(
      `Failed to prepare script environment files: ${
        prepError instanceof Error ? prepError.message : String(prepError)
      }`
    );
  }

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
    env: {
      ...env,
      MUX_OUTPUT: outputFile,
      MUX_PROMPT: promptFile,
    },
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

    // 6. Read back the MUX files
    const MAX_OUTPUT_SIZE = 10 * 1024;
    const MAX_PROMPT_SIZE = 100 * 1024;

    let outputFileContent = "";
    try {
      const content = await readFileString(runtime, outputFile);
      outputFileContent =
        content.length > MAX_OUTPUT_SIZE
          ? content.substring(0, MAX_OUTPUT_SIZE) + "\n\n[Truncated - output too large]"
          : content;
    } catch {
      /* ignore */
    }

    let promptFileContent = "";
    try {
      const content = await readFileString(runtime, promptFile);
      promptFileContent =
        content.length > MAX_PROMPT_SIZE
          ? content.substring(0, MAX_PROMPT_SIZE) + "\n\n[Truncated - prompt too large]"
          : content;
    } catch {
      /* ignore */
    }

    // 7. Cleanup (best effort)
    void execBuffered(runtime, `rm -rf "${runtimeTempDir}"`, { cwd: workspacePath, timeout: 5 });

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
      outputFileContent,
      promptFileContent,
      toolResult,
    });
  } catch (execError) {
    return Err(
      `Script execution failed: ${execError instanceof Error ? execError.message : String(execError)}`
    );
  }
}
