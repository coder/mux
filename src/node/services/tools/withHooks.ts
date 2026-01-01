/**
 * Higher-order function that wraps a tool with hook support.
 *
 * When a .mux/tool_hook executable exists, the tool execution is wrapped:
 * 1. Hook starts, receives tool info via env vars
 * 2. Hook runs pre-logic, prints __MUX_EXEC__ when ready
 * 3. Tool executes, result sent to hook's stdin
 * 4. Hook runs post-logic
 * 5. Hook stderr is appended to tool result as `hook_output` (for LLM feedback)
 *    - On failure: always appended
 *    - On success: appended if non-empty (e.g., formatter ran and modified files)
 */

import type { Tool } from "ai";
import type { Runtime } from "@/node/runtime/Runtime";
import { getHookPath, runWithHook } from "@/node/services/hooks";
import { log } from "@/node/services/log";

export interface HookConfig {
  /** Runtime for hook execution (local or SSH) */
  runtime: Runtime;
  /** Working directory where hooks are discovered */
  cwd: string;
  /** Workspace ID for hook context */
  workspaceId: string;
  /** Additional environment variables to pass to hooks */
  env?: Record<string, string>;
}

/**
 * Wrap a tool to execute within hook context if a hook exists.
 *
 * The wrapper:
 * 1. Checks for .mux/tool_hook or ~/.mux/tool_hook via runtime
 * 2. If no hook, executes tool directly
 * 3. If hook exists, spawns it with tool context via runtime.exec()
 * 4. Waits for hook to signal __MUX_EXEC__ before running tool
 * 5. Sends tool result to hook's stdin
 * 6. Appends hook stderr as `hook_output` (on failure, or on success if non-empty)
 */
export function withHooks<TParameters, TResult>(
  toolName: string,
  tool: Tool<TParameters, TResult>,
  config: HookConfig
): Tool<TParameters, TResult> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return {
    ...tool,
    execute: async (args: TParameters, options) => {
      // Find hook (checked per call - hooks can be added/removed dynamically)
      const hookPath = await getHookPath(config.runtime, config.cwd);

      // No hook - execute tool directly
      if (!hookPath) {
        if (!tool.execute) {
          throw new Error(`Tool ${toolName} does not have an execute function`);
        }
        return tool.execute(args, options);
      }

      // Execute tool within hook context
      log.debug("[withHooks] Running tool with hook", { toolName, hookPath });

      const { result, hook } = await runWithHook<TResult>(
        config.runtime,
        hookPath,
        {
          tool: toolName,
          toolInput: JSON.stringify(args),
          workspaceId: config.workspaceId,
          projectDir: config.cwd,
          env: config.env,
        },
        async () => {
          if (!tool.execute) {
            throw new Error(`Tool ${toolName} does not have an execute function`);
          }
          return tool.execute(args, options);
        },
        {
          slowThresholdMs: 10000,
          onSlowHook: (phase, elapsedMs) => {
            const seconds = (elapsedMs / 1000).toFixed(1);
            log.warn(`[withHooks] Slow ${phase}-hook for ${toolName}: ${seconds}s`);
            // Also log to console for visibility during interactive use
            console.warn(`⚠️  Slow tool hook (${phase}): ${toolName} took ${seconds}s`);
          },
        }
      );

      // Hook blocked tool execution (exited before __MUX_EXEC__)
      if (!hook.toolExecuted) {
        log.debug("[withHooks] Hook blocked tool execution", { toolName, stderr: hook.stderr });
        // Return error result that LLM can see
        const errorResult: { error: string } = {
          error: hook.stderr || "Tool blocked by hook (exited before __MUX_EXEC__)",
        };
        return errorResult as TResult;
      }

      // Combine stdout and stderr for hook output
      const hookOutput = [hook.stdout, hook.stderr].filter(Boolean).join("\n").trim();

      // Always append hook output if there's any (errors, notifications, etc.)
      if (hookOutput) {
        log.debug("[withHooks] Hook produced output", {
          toolName,
          success: hook.success,
          output: hookOutput,
        });
        return appendHookOutput(result, hookOutput);
      }

      // Note: result could be TResult or AsyncIterable<TResult>, but we return it as-is
      // AsyncIterable results (streaming) are passed through without modification
      return result as TResult | AsyncIterable<TResult>;
    },
  } as Tool<TParameters, TResult>;
}

/**
 * Append hook stderr output to tool result.
 * This lets the LLM see hook feedback (errors, formatter notifications) alongside the tool result.
 */
function appendHookOutput<T>(result: T | AsyncIterable<T> | undefined, stderr: string): T {
  if (result === undefined) {
    const errorResult: { error: string } = { error: stderr };
    return errorResult as T;
  }

  // If result is an object, add hook_output field
  if (typeof result === "object" && result !== null) {
    const withOutput: T & { hook_output: string } = {
      ...(result as T),
      hook_output: stderr,
    };
    return withOutput as T;
  }

  // For primitive results, wrap in object
  const wrapped: { result: T | AsyncIterable<T>; hook_output: string } = {
    result,
    hook_output: stderr,
  };
  return wrapped as unknown as T;
}
