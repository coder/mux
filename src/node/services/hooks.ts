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

import * as crypto from "crypto";
import * as path from "path";
import type { Runtime } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";
import { execBuffered, writeFileString } from "@/node/utils/runtime/helpers";

const HOOK_FILENAME = "tool_hook";
const TOOL_INPUT_ENV_LIMIT = 8_000;
const DEFAULT_HOOK_PHASE_TIMEOUT_MS = 5 * 60_000; // 5 minutes
const EXEC_MARKER = "__MUX_EXEC__";

/** Shell-escape a string for safe use in bash -c commands */
function shellEscape(str: string): string {
  // Wrap in single quotes and escape any embedded single quotes
  return `'${str.replace(/'/g, "'\\''")}'`;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === "function"
  );
}
function joinPathLike(basePath: string, ...parts: string[]): string {
  // For SSH runtimes (and most Unix paths), we want POSIX joins.
  // For Windows-style paths, use native joins.
  if (basePath.includes("\\") || /^[a-zA-Z]:/.test(basePath)) {
    return path.join(basePath, ...parts);
  }
  return path.posix.join(basePath, ...parts);
}

export interface HookContext {
  /** Tool name (e.g., "bash", "file_edit_replace_string") */
  tool: string;
  /** Tool input as JSON string */
  toolInput: string;
  /** Workspace ID */
  workspaceId: string;
  /** Runtime temp dir for hook scratch files (paths in the runtime's context) */
  runtimeTempDir?: string;
  /** Project directory (cwd) */
  projectDir: string;
  /** Additional environment variables to pass to hook */
  env?: Record<string, string>;
}

export interface HookResult {
  /** Whether the hook succeeded (exit code 0) */
  success: boolean;
  /** Stdout output from hook before the __MUX_EXEC__ marker */
  stdoutBeforeExec: string;
  /** Stdout output from hook (after __MUX_EXEC__ marker) */
  stdout: string;
  /** Stderr output from hook */
  stderr: string;
  /** Hook process exit code */
  exitCode: number;
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
  const projectHook = joinPathLike(projectDir, ".mux", HOOK_FILENAME);
  if (await isFile(runtime, projectHook)) {
    return projectHook;
  }

  // Fall back to user-level hook (resolve ~ for SSH compatibility)
  try {
    const homeDir = await runtime.resolvePath("~");
    const userHook = joinPathLike(homeDir, ".mux", HOOK_FILENAME);
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

/** Options for hook timing warnings */
export interface HookTimingOptions {
  /** Threshold in ms before warning about slow hooks (default: 10000) */
  slowThresholdMs?: number;
  /** Maximum time allowed for hook pre-logic (until __MUX_EXEC__). Defaults to 5 minutes. */
  preHookTimeoutMs?: number;
  /** Maximum time allowed for hook post-logic (after tool result is sent). Defaults to 5 minutes. */
  postHookTimeoutMs?: number;
  /** Callback when hook phase exceeds threshold */
  onSlowHook?: (phase: "pre" | "post", elapsedMs: number) => void;
}

/**
 * Execute a tool with hook wrapping.
 * Uses runtime.exec() so hooks work for both local and SSH workspaces.
 *
 * @param runtime Runtime to execute the hook in
 * @param hookPath Path to the hook executable
 * @param context Hook context with tool info
 * @param executeTool Callback to execute the actual tool (called when hook signals __MUX_EXEC__)
 * @param timingOptions Optional timing/warning configuration
 * @returns Hook result with success status and any stderr output
 */
export async function runWithHook<T>(
  runtime: Runtime,
  hookPath: string,
  context: HookContext,
  executeTool: () => Promise<T | AsyncIterable<T>>,
  timingOptions?: HookTimingOptions
): Promise<{ result: T | AsyncIterable<T> | undefined; hook: HookResult }> {
  const slowThresholdMs = timingOptions?.slowThresholdMs ?? 10000;
  const onSlowHook = timingOptions?.onSlowHook;
  const preHookTimeoutMs = timingOptions?.preHookTimeoutMs ?? DEFAULT_HOOK_PHASE_TIMEOUT_MS;
  const postHookTimeoutMs = timingOptions?.postHookTimeoutMs ?? DEFAULT_HOOK_PHASE_TIMEOUT_MS;
  const hookStartTime = Date.now();

  let toolInputPath: string | undefined;
  let toolInputEnv = context.toolInput;
  if (context.toolInput.length > TOOL_INPUT_ENV_LIMIT) {
    // Tool input can be massive (file_edit_* old/new strings) and can exceed limits
    // when injected as env vars (especially over SSH, where env is embedded into a
    // single bash -c command string). Prefer writing the full JSON to a temp file.
    try {
      const tempDir = context.runtimeTempDir ?? "/tmp";
      toolInputPath = joinPathLike(
        tempDir,
        `mux-tool-input-${Date.now()}-${crypto.randomUUID()}.json`
      );
      await writeFileString(runtime, toolInputPath, context.toolInput);
      toolInputEnv = "__MUX_TOOL_INPUT_FILE__";
    } catch (err) {
      log.debug("[hooks] Failed to write tool input to temp file; falling back to truncation", {
        error: err,
      });
      toolInputPath = undefined;
      toolInputEnv = context.toolInput.slice(0, TOOL_INPUT_ENV_LIMIT);
    }
  }

  const hookEnv: Record<string, string> = {
    ...(context.env ?? {}),
    MUX_TOOL: context.tool,
    MUX_TOOL_INPUT: toolInputEnv,
    MUX_WORKSPACE_ID: context.workspaceId,
    MUX_PROJECT_DIR: context.projectDir,
  };
  if (toolInputPath) {
    hookEnv.MUX_TOOL_INPUT_PATH = toolInputPath;
  }

  const abortController = new AbortController();
  let timeoutPhase: "pre" | "post" | undefined;
  let preTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let postTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

  if (preHookTimeoutMs > 0) {
    preTimeoutHandle = setTimeout(() => {
      timeoutPhase = "pre";
      abortController.abort();
    }, preHookTimeoutMs);
  }

  let stream;
  try {
    // Shell-escape the hook path to handle spaces and special characters
    // runtime.exec() uses bash -c, so unquoted paths would break
    stream = await runtime.exec(shellEscape(hookPath), {
      cwd: context.projectDir,
      env: hookEnv,
      abortSignal: abortController.signal,
    });
  } catch (err) {
    if (preTimeoutHandle) {
      clearTimeout(preTimeoutHandle);
      preTimeoutHandle = undefined;
    }
    log.error("[hooks] Failed to spawn hook", { hookPath, error: err });
    if (toolInputPath) {
      try {
        await execBuffered(runtime, `rm -f ${shellEscape(toolInputPath)}`, {
          cwd: context.projectDir,
          timeout: 5,
        });
      } catch {
        // Best-effort cleanup
      }
    }
    return {
      result: undefined,
      hook: {
        success: false,
        stdoutBeforeExec: "",
        stdout: "",
        stderr: `Failed to execute hook: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: -1,
        toolExecuted: false,
      },
    };
  }

  let toolResult: T | AsyncIterable<T> | undefined;
  let toolError: Error | undefined;
  let hookStdinWriteError: Error | undefined;
  let toolExecuted = false;
  let toolResultSentTime: number | undefined;
  let stderrOutput = "";
  let stdoutBuffer = "";
  let stdoutBeforeExec = "";
  let stdoutAfterMarker = "";
  let toolPromise: Promise<void> | undefined;

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
    } catch {
      // Ignore stream errors (e.g. abort)
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
        continue;
      }

      stdoutBuffer += chunk;

      const markerIdx = stdoutBuffer.indexOf(EXEC_MARKER);
      if (markerIdx === -1) {
        continue;
      }

      // Marker detected: allow tool execution.
      // Stop the pre-hook timeout clock and start the tool.
      if (preTimeoutHandle) {
        clearTimeout(preTimeoutHandle);
        preTimeoutHandle = undefined;
      }

      // Check pre-hook timing before marking as executed
      const preHookElapsed = Date.now() - hookStartTime;
      if (onSlowHook && preHookElapsed > slowThresholdMs) {
        onSlowHook("pre", preHookElapsed);
      }

      toolExecuted = true;
      stdoutBeforeExec = stdoutBuffer.slice(0, markerIdx);
      stdoutAfterMarker = stdoutBuffer.slice(markerIdx + EXEC_MARKER.length);

      // Execute tool + send result to hook stdin in the background so we can
      // continue draining stdout (hooks may log after __MUX_EXEC__).
      toolPromise = (async () => {
        try {
          try {
            toolResult = await executeTool();
          } catch (err) {
            toolError = err instanceof Error ? err : new Error(String(err));
          }

          const payload = toolError ? { error: toolError.message } : toolResult;
          const payloadForHook = isAsyncIterable(payload) ? { streaming: true } : payload;

          const writer = stream.stdin.getWriter();
          try {
            await writer.write(new TextEncoder().encode(JSON.stringify(payloadForHook) + "\n"));
          } catch (err) {
            hookStdinWriteError = err instanceof Error ? err : new Error(String(err));
          } finally {
            try {
              await writer.close();
            } catch {
              // Ignore close errors (e.g. EPIPE if hook exited)
            }
            toolResultSentTime = Date.now();

            if (postHookTimeoutMs > 0) {
              postTimeoutHandle = setTimeout(() => {
                timeoutPhase = "post";
                abortController.abort();
              }, postHookTimeoutMs);
            }
          }
        } catch (err) {
          // This should never throw, but guard to avoid unhandled rejections.
          hookStdinWriteError = err instanceof Error ? err : new Error(String(err));
        }
      })();
    }
  } catch {
    // Ignore stream errors (e.g. abort)
  } finally {
    stdoutReader.releaseLock();
  }

  // If hook exited before __MUX_EXEC__, close stdin
  if (!toolExecuted) {
    // Cancel the pre-hook timeout.
    if (preTimeoutHandle) {
      clearTimeout(preTimeoutHandle);
      preTimeoutHandle = undefined;
    }
    const writer = stream.stdin.getWriter();
    try {
      await writer.close();
    } catch {
      // Ignore close errors (e.g. hook already exited)
    }
  }

  // Wait for tool execution (if started), stderr collection, and exit code
  await toolPromise;
  await stderrPromise;
  const exitCode = await stream.exitCode;

  if (postTimeoutHandle) {
    clearTimeout(postTimeoutHandle);
    postTimeoutHandle = undefined;
  }

  // Check post-hook timing (time from result sent to hook exit)
  if (onSlowHook && toolResultSentTime) {
    const postHookElapsed = Date.now() - toolResultSentTime;
    if (postHookElapsed > slowThresholdMs) {
      onSlowHook("post", postHookElapsed);
    }
  }

  if (timeoutPhase === "pre") {
    stderrOutput += `\nHook timed out before ${EXEC_MARKER} (${preHookTimeoutMs}ms)`;
  } else if (timeoutPhase === "post") {
    stderrOutput += `\nHook timed out after tool result was sent (${postHookTimeoutMs}ms)`;
  }
  if (hookStdinWriteError) {
    stderrOutput += `\nFailed to write tool result to hook stdin: ${hookStdinWriteError.message}`;
  }

  if (toolInputPath) {
    try {
      await execBuffered(runtime, `rm -f ${shellEscape(toolInputPath)}`, {
        cwd: context.projectDir,
        timeout: 5,
      });
    } catch {
      // Best-effort cleanup
    }
  }

  // If tool threw an error, rethrow it after hook completes
  // This ensures tool failures propagate even when hooks are present
  if (toolError) {
    throw toolError;
  }

  return {
    result: toolResult,
    hook: {
      success: exitCode === 0,
      stdoutBeforeExec: (toolExecuted ? stdoutBeforeExec : stdoutBuffer).trim(),
      stdout: stdoutAfterMarker.trim(),
      stderr: stderrOutput.trim(),
      exitCode,
      toolExecuted,
    },
  };
}
