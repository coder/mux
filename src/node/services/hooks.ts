/**
 * Tool Hook System
 *
 * Provides a mechanism for users to wrap tool executions with custom pre/post logic.
 * Hooks can be used for:
 * - Environment setup (direnv, nvm, virtualenv)
 * - Linting/type-checking after file edits
 * - Blocking dangerous operations
 * - Custom logging/metrics
 *
 * Hook Location:
 *   1. .mux/tool_hook (project-level, committed)
 *   2. ~/.mux/tool_hook (user-level, personal)
 *
 * Protocol:
 *   1. Hook receives MUX_TOOL, MUX_TOOL_INPUT, etc. as env vars
 *   2. Hook runs pre-logic
 *   3. Hook prints __MUX_EXEC__ to signal readiness
 *   4. Mux executes the tool, sends result JSON to hook's stdin
 *   5. Hook reads result, runs post-logic
 *   6. Hook exits (non-zero = failure fed back to LLM)
 *
 * Runtime Support:
 *   Hooks execute via the Runtime abstraction, so they work correctly for both
 *   local and SSH workspaces. For SSH, the hook file must exist on the remote machine.
 */

import * as path from "path";
import type { Runtime } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";

const HOOK_FILENAME = "tool_hook";
const EXEC_MARKER = "__MUX_EXEC__";

export interface HookContext {
  /** Tool name (e.g., "bash", "file_edit_replace_string") */
  tool: string;
  /** Tool input as JSON string */
  toolInput: string;
  /** Workspace ID */
  workspaceId: string;
  /** Project directory (cwd) */
  projectDir: string;
  /** Additional environment variables to pass to hook */
  env?: Record<string, string>;
}

export interface HookResult {
  /** Whether the hook succeeded (exit code 0) */
  success: boolean;
  /** Stdout output from hook (after __MUX_EXEC__ marker) */
  stdout: string;
  /** Stderr output from hook */
  stderr: string;
  /** Whether the tool was executed (hook printed __MUX_EXEC__) */
  toolExecuted: boolean;
}

/**
 * Find the tool_hook executable for a given project directory.
 * Uses runtime abstraction so it works for both local and SSH workspaces.
 * Returns null if no hook exists.
 *
 * Note: We don't check execute permissions via runtime since FileStat doesn't
 * expose mode bits. The hook will fail at execution time if not executable.
 */
export async function getHookPath(runtime: Runtime, projectDir: string): Promise<string | null> {
  // Check project-level hook first
  const projectHook = path.posix.join(projectDir, ".mux", HOOK_FILENAME);
  if (await isFile(runtime, projectHook)) {
    return projectHook;
  }

  // Fall back to user-level hook (resolve ~ for SSH compatibility)
  try {
    const homeDir = await runtime.resolvePath("~");
    const userHook = path.posix.join(homeDir, ".mux", HOOK_FILENAME);
    if (await isFile(runtime, userHook)) {
      return userHook;
    }
  } catch {
    // resolvePath failed - skip user hook
  }

  return null;
}

async function isFile(runtime: Runtime, filePath: string): Promise<boolean> {
  try {
    const stat = await runtime.stat(filePath);
    return !stat.isDirectory;
  } catch {
    return false;
  }
}

/**
 * Execute a tool with hook wrapping.
 * Uses runtime.exec() so hooks work for both local and SSH workspaces.
 *
 * @param runtime Runtime to execute the hook in
 * @param hookPath Path to the hook executable
 * @param context Hook context with tool info
 * @param executeTool Callback to execute the actual tool (called when hook signals __MUX_EXEC__)
 * @returns Hook result with success status and any stderr output
 */
export async function runWithHook<T>(
  runtime: Runtime,
  hookPath: string,
  context: HookContext,
  executeTool: () => Promise<T | AsyncIterable<T>>
): Promise<{ result: T | AsyncIterable<T> | undefined; hook: HookResult }> {
  const hookEnv: Record<string, string> = {
    ...(context.env ?? {}),
    MUX_TOOL: context.tool,
    MUX_TOOL_INPUT: context.toolInput,
    MUX_WORKSPACE_ID: context.workspaceId,
    MUX_PROJECT_DIR: context.projectDir,
  };

  let stream;
  try {
    stream = await runtime.exec(hookPath, {
      cwd: context.projectDir,
      env: hookEnv,
      timeout: 300, // 5 minute timeout for hooks
    });
  } catch (err) {
    log.error("[hooks] Failed to spawn hook", { hookPath, error: err });
    return {
      result: undefined,
      hook: {
        success: false,
        stdout: "",
        stderr: `Failed to execute hook: ${err instanceof Error ? err.message : String(err)}`,
        toolExecuted: false,
      },
    };
  }

  let toolResult: T | AsyncIterable<T> | undefined;
  let toolError: Error | undefined;
  let toolExecuted = false;
  let stderrOutput = "";
  let stdoutBuffer = "";
  let stdoutAfterMarker = "";

  // Read stderr in background
  const stderrReader = stream.stderr.getReader();
  const stderrPromise = (async () => {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrOutput += decoder.decode(value, { stream: true });
      }
    } finally {
      stderrReader.releaseLock();
    }
  })();

  // Read stdout, watching for __MUX_EXEC__ marker
  const stdoutReader = stream.stdout.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await stdoutReader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });

      if (toolExecuted) {
        // After marker: capture for hook output
        stdoutAfterMarker += chunk;
      } else {
        stdoutBuffer += chunk;

        // Check for marker in accumulated buffer
        if (stdoutBuffer.includes(EXEC_MARKER)) {
          toolExecuted = true;

          // Capture anything after the marker in this chunk
          const markerIdx = stdoutBuffer.indexOf(EXEC_MARKER);
          stdoutAfterMarker = stdoutBuffer.slice(markerIdx + EXEC_MARKER.length);

          // Execute the tool and send result to hook's stdin
          const writer = stream.stdin.getWriter();
          try {
            toolResult = await executeTool();
            const resultJson = JSON.stringify(toolResult) + "\n";
            await writer.write(new TextEncoder().encode(resultJson));
          } catch (err) {
            // Capture error to rethrow after hook completes
            toolError = err instanceof Error ? err : new Error(String(err));
            const errorResult = { error: toolError.message };
            await writer.write(new TextEncoder().encode(JSON.stringify(errorResult) + "\n"));
          } finally {
            await writer.close();
          }
        }
      }
    }
  } finally {
    stdoutReader.releaseLock();
  }

  // If hook exited before __MUX_EXEC__, close stdin
  if (!toolExecuted) {
    const writer = stream.stdin.getWriter();
    await writer.close();
  }

  // Wait for stderr collection and exit code
  await stderrPromise;
  const exitCode = await stream.exitCode;

  // If tool threw an error, rethrow it after hook completes
  // This ensures tool failures propagate even when hooks are present
  if (toolError) {
    throw toolError;
  }

  return {
    result: toolResult,
    hook: {
      success: exitCode === 0,
      stdout: stdoutAfterMarker.trim(),
      stderr: stderrOutput.trim(),
      toolExecuted,
    },
  };
}
