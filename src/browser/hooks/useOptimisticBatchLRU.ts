/**
 * Hook for optimistic batch data fetching with LRU cache.
 *
 * Seeds state from persisted LRU cache immediately (no layout flash),
 * then fetches fresh data in background (stale-while-revalidate pattern).
 *
 * Ideal for cases like ArchivedWorkspaces costs where:
 * - We want to show cached values instantly
 * - Fresh data can load in the background
 * - We batch requests for efficiency
 */

import React from "react";
import type { LRUCache } from "@/browser/utils/lruCache";

export type OptimisticBatchStatus = "idle" | "loading" | "loaded" | "error";

export interface OptimisticBatchResult<T> {
  /** Values keyed by ID. Seeded from cache on first render, updated after fetch. */
  values: Record<string, T | undefined>;
  /** Current fetch status */
  status: OptimisticBatchStatus;
  /** Manually trigger a refresh */
  refresh: () => void;
}

export interface UseOptimisticBatchLRUOptions<T> {
  /** Keys to fetch (e.g., workspace IDs) */
  keys: string[];
  /** LRU cache instance for persistence */
  cache: LRUCache<T>;
  /** Batch fetch function. Returns record of key → value (or undefined if not found). */
  fetchBatch: (keys: string[]) => Promise<Record<string, T | undefined>>;
  /** If true, skip fetching (e.g., when API not ready) */
  skip?: boolean;
}

/**
 * Optimistic batch fetching with LRU cache.
 *
 * On mount:
 * 1. Immediately seeds `values` from cache (fast first paint)
 * 2. Calls `fetchBatch` for all keys
 * 3. Updates cache + state with fresh data
 *
 * @example
 * ```tsx
 * const { values, status } = useOptimisticBatchLRU({
 *   keys: workspaceIds,
 *   cache: sessionCostCache,
 *   fetchBatch: async (ids) => {
 *     const usage = await api.workspace.getSessionUsageBatch({ workspaceIds: ids });
 *     return Object.fromEntries(ids.map(id => [id, computeCost(usage[id])]));
 *   },
 * });
 *
 * // values[workspaceId] is immediately available from cache
 * // status tells you if fresh data is loading
 * ```
 */
export function useOptimisticBatchLRU<T>({
  keys,
  cache,
  fetchBatch,
  skip = false,
}: UseOptimisticBatchLRUOptions<T>): OptimisticBatchResult<T> {
  // Seed from cache synchronously on first render
  const [values, setValues] = React.useState<Record<string, T | undefined>>(() => {
    const initial: Record<string, T | undefined> = {};
    for (const key of keys) {
      const cached = cache.get(key);
      if (cached !== null) {
        initial[key] = cached;
      }
    }
    return initial;
  });

  const [status, setStatus] = React.useState<OptimisticBatchStatus>("idle");

  // Stable reference for keys to avoid unnecessary refetches
  const keysRef = React.useRef(keys);
  const keysChanged =
    keys.length !== keysRef.current.length || keys.some((k, i) => k !== keysRef.current[i]);
  if (keysChanged) {
    keysRef.current = keys;
  }

  // Fetch function - also updates cache
  const doFetch = React.useCallback(async () => {
    const currentKeys = keysRef.current;
    if (currentKeys.length === 0) {
      setStatus("loaded");
      return;
    }

    setStatus("loading");
    try {
      const freshData = await fetchBatch(currentKeys);

      // Update cache + state
      setValues((prev) => {
        const next = { ...prev };
        for (const key of currentKeys) {
          const value = freshData[key];
          if (value !== undefined) {
            cache.set(key, value);
            next[key] = value;
          } else if (next[key] === undefined) {
            // Keep cached value if fetch returned undefined
          }
        }
        return next;
      });

      setStatus("loaded");
    } catch {
      setStatus("error");
    }
  }, [cache, fetchBatch]);

  // Fetch on mount and when keys change
  React.useEffect(() => {
    if (skip) return;

    // Re-seed from cache when keys change (for immediate values)
    if (keysChanged) {
      setValues((prev) => {
        const next = { ...prev };
        for (const key of keys) {
          if (next[key] === undefined) {
            const cached = cache.get(key);
            if (cached !== null) {
              next[key] = cached;
            }
          }
        }
        return next;
      });
    }

    void doFetch();
  }, [skip, keysChanged, keys, cache, doFetch]);

  // Wrap refresh to be a void function (callers don't need to await)
  const refresh = React.useCallback(() => {
    void doFetch();
  }, [doFetch]);

  return { values, status, refresh };
}
