import type { Tool } from "ai";
import assert from "@/common/utils/assert";
import { cloneToolPreservingDescriptors } from "@/common/utils/tools/cloneToolPreservingDescriptors";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";

/**
 * Serialize sibling tool execution for a single stream without changing the
 * provider's parallel-tool-call planning behavior.
 *
 * We intentionally scope the mutex to the returned tool map so independent
 * streams can still execute concurrently. Holding the lock across the full
 * execute chain preserves ordering across all per-tool wrappers and side effects.
 */
export function withSequentialExecution(
  tools: Record<string, Tool> | undefined
): Record<string, Tool> | undefined {
  if (!tools) {
    return tools;
  }

  const executionLock = new AsyncMutex();
  const wrappedTools: Record<string, Tool> = { ...tools };

  for (const [toolName, baseTool] of Object.entries(tools)) {
    assert(toolName.length > 0, "tool names must be non-empty");

    const baseToolRecord = baseTool as Record<string, unknown>;
    const originalExecute = baseToolRecord.execute;
    if (typeof originalExecute !== "function") {
      continue;
    }

    const executeFn = originalExecute as (
      this: unknown,
      args: unknown,
      options: unknown
    ) => unknown;
    const wrappedTool = cloneToolPreservingDescriptors(baseTool);
    const wrappedToolRecord = wrappedTool as Record<string, unknown>;

    wrappedToolRecord.execute = async (args: unknown, options: unknown) => {
      await using _lock = await executionLock.acquire();
      return await executeFn.call(baseTool, args, options);
    };

    wrappedTools[toolName] = wrappedTool;
  }

  return wrappedTools;
}
