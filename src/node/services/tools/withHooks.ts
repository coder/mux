/**
 * Higher-order function that wraps a tool with hook support.
 *
 * When a .mux/tool_hook executable exists, the tool execution is wrapped:
 * 1. Hook starts, receives tool info via env vars
 * 2. Hook runs pre-logic, prints __MUX_EXEC__ when ready
 * 3. Tool executes, result sent to hook's stdin
 * 4. Hook runs post-logic
 * 5. Hook output is appended to tool result as `hook_output` (for LLM feedback)
 *    - On failure: always appended
 *    - On success: appended if non-empty (e.g., formatter ran and modified files)
 */

import assert from "@/common/utils/assert";
import type { Tool } from "ai";
import type { Runtime } from "@/node/runtime/Runtime";
import { getHookPath, runWithHook } from "@/node/services/hooks";
import { log } from "@/node/services/log";

export interface HookConfig {
  /** Runtime for hook execution (local or SSH) */
  runtime: Runtime;
  /** Runtime temp dir for hook scratch files (paths in the runtime's context) */
  runtimeTempDir: string;
  /** Working directory where hooks are discovered */
  cwd: string;
  /** Workspace ID for hook context */
  workspaceId: string;
  /** Additional environment variables to pass to hooks */
  env?: Record<string, string>;
}

const HOOK_OUTPUT_MAX_CHARS = 64 * 1024;

function truncateHookOutput(output: string): string {
  if (output.length <= HOOK_OUTPUT_MAX_CHARS) {
    return output;
  }
  return output.slice(0, HOOK_OUTPUT_MAX_CHARS) + "\n\n[hook_output truncated]";
}

function cloneToolPreservingDescriptors(tool: unknown): Tool {
  assert(tool && typeof tool === "object", "tool must be an object");

  // Clone the tool without invoking getters (important for some dynamic tools).
  const prototype = Object.getPrototypeOf(tool) as unknown;
  assert(
    prototype === null || typeof prototype === "object",
    "tool prototype must be an object or null"
  );

  const clone = Object.create(prototype) as object;
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(tool));
  return clone as Tool;
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
 * 6. Appends hook output as `hook_output` (on failure, or on success if non-empty)
 */
export function withHooks<TParameters, TResult>(
  toolName: string,
  tool: Tool<TParameters, TResult>,
  config: HookConfig
): Tool<TParameters, TResult> {
  // Access the tool as a record to get its properties.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolRecord = tool as any as Record<string, unknown>;
  const originalExecute = toolRecord.execute;

  if (typeof originalExecute !== "function") {
    return tool;
  }

  const executeFn = originalExecute as (
    this: unknown,
    args: TParameters,
    options: unknown
  ) => unknown;

  // Avoid mutating cached tools in place (e.g. MCP tools cached per workspace).
  // Repeated getToolsForModel() calls should not stack wrappers.
  const wrappedTool = cloneToolPreservingDescriptors(tool) as Tool<TParameters, TResult>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrappedToolRecord = wrappedTool as any as Record<string, unknown>;

  wrappedToolRecord.execute = async (args: TParameters, options: unknown) => {
    // Find hook (checked per call - hooks can be added/removed dynamically)
    const hookPath = await getHookPath(config.runtime, config.cwd);

    // No hook - execute tool directly
    if (!hookPath) {
      return executeFn.call(tool, args, options) as TResult;
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
        runtimeTempDir: config.runtimeTempDir,
        env: config.env,
      },
      () => Promise.resolve(executeFn.call(tool, args, options) as TResult),
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
      const blockOutput = truncateHookOutput(
        [hook.stdoutBeforeExec, hook.stderr].filter(Boolean).join("\n").trim()
      );
      log.debug("[withHooks] Hook blocked tool execution", { toolName, output: blockOutput });
      const errorResult: { error: string } = {
        error: blockOutput || "Tool blocked by hook (exited before __MUX_EXEC__)",
      };
      return errorResult as TResult;
    }

    // Combine stdout and stderr for hook output
    let hookOutput = [hook.stdout, hook.stderr].filter(Boolean).join("\n").trim();

    // Always surface hook failures, even if the hook didn't print anything.
    if (!hook.success && !hookOutput) {
      hookOutput = `Tool hook failed (exit code ${hook.exitCode})`;
    }

    if (hookOutput) {
      hookOutput = truncateHookOutput(hookOutput);
      log.debug("[withHooks] Hook produced output", {
        toolName,
        success: hook.success,
        output: hookOutput,
      });
      return appendHookOutput(result, hookOutput) as TResult;
    }

    // Note: result could be TResult or AsyncIterable<TResult>, but we return it as-is
    return result as TResult | AsyncIterable<TResult>;
  };

  return wrappedTool;
}

/** Check if a value is an AsyncIterable (streaming result) */
function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === "function"
  );
}

/**
 * Append hook output to tool result.
 * This lets the LLM see hook feedback (errors, formatter notifications) alongside the tool result.
 *
 * Note: AsyncIterable (streaming) results are wrapped to preserve the iterator while attaching hook_output.
 */
function appendHookOutput<T>(
  result: T | AsyncIterable<T> | undefined,
  output: string
): T | AsyncIterable<T> {
  if (result === undefined) {
    const errorResult: { error: string } = { error: output };
    return errorResult as T;
  }

  // AsyncIterable (streaming) results: preserve streaming while attaching hook_output.
  if (isAsyncIterable<T>(result)) {
    const iterable = result;
    const iteratorFn = iterable[Symbol.asyncIterator].bind(iterable);
    const wrappedIterable: AsyncIterable<T> & { hook_output: string } = {
      hook_output: output,
      [Symbol.asyncIterator]: iteratorFn,
    };
    return wrappedIterable;
  }

  // If result is an object, add hook_output field
  if (typeof result === "object" && result !== null) {
    const withOutput: T & { hook_output: string } = {
      ...(result as T),
      hook_output: output,
    };
    return withOutput as T;
  }

  // For primitive results, wrap in object
  const wrapped: { result: T; hook_output: string } = {
    result,
    hook_output: output,
  };
  return wrapped as unknown as T;
}
