import { useCallback, useEffect, useMemo, useState } from "react";
import type { CachedMCPTestResult, MCPTestResult } from "@/common/types/mcp";
import { getMCPTestResultsKey } from "@/common/constants/storage";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";

type CachedResults = Record<string, CachedMCPTestResult>;

/**
 * Hook for managing MCP server test results cache.
 * Persists results to localStorage, shared across Settings and WorkspaceMCPModal.
 */
export function useMCPTestCache(projectPath: string) {
  const storageKey = useMemo(
    () => (projectPath ? getMCPTestResultsKey(projectPath) : ""),
    [projectPath]
  );

  const [cache, setCache] = useState<CachedResults>(() =>
    storageKey ? readPersistedState<CachedResults>(storageKey, {}) : {}
  );

  // Reload cache when project changes
  useEffect(() => {
    if (storageKey) {
      setCache(readPersistedState<CachedResults>(storageKey, {}));
    } else {
      setCache({});
    }
  }, [storageKey]);

  /** Update cache with a test result */
  const setResult = useCallback(
    (name: string, result: MCPTestResult) => {
      const entry: CachedMCPTestResult = { result, testedAt: Date.now() };
      setCache((prev) => {
        const next = { ...prev, [name]: entry };
        if (storageKey) updatePersistedState(storageKey, next);
        return next;
      });
    },
    [storageKey]
  );

  /** Clear cached result for a server */
  const clearResult = useCallback(
    (name: string) => {
      setCache((prev) => {
        const next = { ...prev };
        delete next[name];
        if (storageKey) updatePersistedState(storageKey, next);
        return next;
      });
    },
    [storageKey]
  );

  /** Get tools for a server (returns null if not cached or failed) */
  const getTools = useCallback(
    (name: string): string[] | null => {
      const cached = cache[name];
      if (cached?.result.success) {
        return cached.result.tools;
      }
      return null;
    },
    [cache]
  );

  /** Reload cache from storage (useful when opening modal) */
  const reload = useCallback(() => {
    if (storageKey) {
      setCache(readPersistedState<CachedResults>(storageKey, {}));
    }
  }, [storageKey]);

  return { cache, setResult, clearResult, getTools, reload };
}
