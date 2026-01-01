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
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
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
  /** Stderr output from hook (for error feedback to LLM) */
  stderr: string;
  /** Whether the tool was executed (hook printed __MUX_EXEC__) */
  toolExecuted: boolean;
}

/**
 * Find the tool_hook executable for a given project directory.
 * Returns null if no hook exists or is not executable.
 */
export async function getHookPath(projectDir: string): Promise<string | null> {
  // Check project-level hook first
  const projectHook = path.join(projectDir, ".mux", HOOK_FILENAME);
  if (await isExecutable(projectHook)) {
    return projectHook;
  }

  // Fall back to user-level hook
  const userHook = path.join(os.homedir(), ".mux", HOOK_FILENAME);
  if (await isExecutable(userHook)) {
    return userHook;
  }

  return null;
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;

    // Check execute permission (any of user/group/other)
    // On Windows, we just check if the file exists since permission model differs
    if (process.platform === "win32") {
      return true;
    }

    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Execute a tool with hook wrapping.
 *
 * @param hookPath Path to the hook executable
 * @param context Hook context with tool info
 * @param executeTool Callback to execute the actual tool (called when hook signals __MUX_EXEC__)
 * @returns Hook result with success status and any stderr output
 */
export async function runWithHook<T>(
  hookPath: string,
  context: HookContext,
  executeTool: () => Promise<T | AsyncIterable<T>>
): Promise<{ result: T | AsyncIterable<T> | undefined; hook: HookResult }> {
  return new Promise((resolve) => {
    const hookEnv: Record<string, string> = {
      ...process.env,
      ...(context.env ?? {}),
      MUX_TOOL: context.tool,
      MUX_TOOL_INPUT: context.toolInput,
      MUX_WORKSPACE_ID: context.workspaceId,
      MUX_PROJECT_DIR: context.projectDir,
    };

    const child = spawn(hookPath, [], {
      cwd: context.projectDir,
      env: hookEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let toolResult: T | AsyncIterable<T> | undefined;
    let toolExecuted = false;
    let stderrOutput = "";
    let stdoutBuffer = "";

    // Collect stderr for error feedback
    child.stderr.on("data", (data: Buffer) => {
      stderrOutput += data.toString();
    });

    // Watch stdout for __MUX_EXEC__ marker
    child.stdout.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();

      // Check for marker in accumulated buffer
      if (!toolExecuted && stdoutBuffer.includes(EXEC_MARKER)) {
        toolExecuted = true;

        // Execute the tool and send result to hook's stdin
        executeTool()
          .then((result) => {
            toolResult = result;
            // Send result as JSON line to hook's stdin
            child.stdin.write(JSON.stringify(result) + "\n");
            child.stdin.end();
          })
          .catch((err) => {
            // If tool execution fails, send error to hook
            const errorResult = { error: err instanceof Error ? err.message : String(err) };
            child.stdin.write(JSON.stringify(errorResult) + "\n");
            child.stdin.end();
          });
      }
    });

    child.on("error", (err) => {
      log.error("[hooks] Failed to spawn hook", { hookPath, error: err });
      resolve({
        result: undefined,
        hook: {
          success: false,
          stderr: `Failed to execute hook: ${err.message}`,
          toolExecuted: false,
        },
      });
    });

    child.on("exit", (code) => {
      // If hook exited before __MUX_EXEC__, tool was blocked
      if (!toolExecuted) {
        child.stdin.end();
      }

      resolve({
        result: toolResult,
        hook: {
          success: code === 0,
          stderr: stderrOutput,
          toolExecuted,
        },
      });
    });
  });
}
