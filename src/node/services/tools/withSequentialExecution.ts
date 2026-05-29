import type { Tool } from "ai";
import assert from "@/common/utils/assert";
import { cloneToolPreservingDescriptors } from "@/common/utils/tools/cloneToolPreservingDescriptors";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";

type AsyncMutexGuard = Awaited<ReturnType<AsyncMutex["acquire"]>>;

interface ToolExecutionContext {
  abortSignal?: AbortSignal;
}

function getAbortSignal(options: unknown): AbortSignal | undefined {
  if (typeof options !== "object" || options === null) {
    return undefined;
  }

  const context = options as ToolExecutionContext;
  return context.abortSignal;
}

function releaseLockAfterAbort(acquirePromise: Promise<AsyncMutexGuard>): void {
  void acquirePromise
    .then(async (lock) => {
      await lock[Symbol.asyncDispose]();
    })
    .catch(() => {
      // Ignore acquisition failures while cleaning up an aborted waiter.
    });
}

async function acquireLockOrAbort(
  executionLock: AsyncMutex,
  abortSignal?: AbortSignal
): Promise<AsyncMutexGuard> {
  if (abortSignal?.aborted) {
    throw new Error("Interrupted");
  }

  const acquirePromise = executionLock.acquire();
  if (!abortSignal) {
    return await acquirePromise;
  }

  let abortListener: (() => void) | undefined;
  let didAcquireLock = false;
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => {
      reject(new Error("Interrupted"));
    };
    abortSignal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    const lock = await Promise.race([acquirePromise, abortPromise]);
    didAcquireLock = true;
    if (abortListener) {
      abortSignal.removeEventListener("abort", abortListener);
    }

    if (abortSignal.aborted) {
      await lock[Symbol.asyncDispose]();
      throw new Error("Interrupted");
    }

    return lock;
  } catch (error) {
    if (abortListener) {
      abortSignal.removeEventListener("abort", abortListener);
    }
    if (!didAcquireLock && error instanceof Error && error.message === "Interrupted") {
      releaseLockAfterAbort(acquirePromise);
    }
    throw error;
  }
}

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
      const abortSignal = getAbortSignal(options);
      await using _lock = await acquireLockOrAbort(executionLock, abortSignal);
      return await executeFn.call(baseTool, args, options);
    };

    wrappedTools[toolName] = wrappedTool;
  }

  return wrappedTools;
}
