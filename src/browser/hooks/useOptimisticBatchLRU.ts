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

  // Capture the latest fetchBatch without making it a dependency.
  //
  // Call sites often pass inline async functions; if we depend on the callback
  // identity, we can refetch on every render.
  const fetchBatchRef = React.useRef(fetchBatch);
  fetchBatchRef.current = fetchBatch;

  // Prevent out-of-order fetches from overwriting newer results.
  const requestIdRef = React.useRef(0);

  // We want to refetch when the *contents* of `keys` change, not merely when the
  // array identity changes.
  //
  // Also: avoid having a `keysChanged` boolean in the effect dependency list.
  // That pattern can cause a double-fetch when `keysChanged` flips true→false
  // across renders.
  const keysKey = React.useMemo(() => keys.join("\u0000"), [keys]);
  const keysKeyRef = React.useRef(keysKey);
  const keysRef = React.useRef(keys);
  if (keysKeyRef.current !== keysKey) {
    keysKeyRef.current = keysKey;
    keysRef.current = keys;
  }

  // Fetch function - reads keys from refs and writes through to the cache.
  const doFetch = React.useCallback(async () => {
    const requestId = ++requestIdRef.current;

    const currentKeys = keysRef.current;
    if (currentKeys.length === 0) {
      setStatus("loaded");
      return;
    }

    setStatus("loading");
    try {
      const freshData = await fetchBatchRef.current(currentKeys);
      if (requestId !== requestIdRef.current) return;

      // Decide what to update. If the response doesn't contain a key at all, we
      // treat it as "no update" (keep cached value). If the response contains a
      // key with `undefined`, we treat it as an explicit delete.
      const updates: Array<{ key: string; value: T | undefined }> = [];
      for (const key of currentKeys) {
        if (!Object.prototype.hasOwnProperty.call(freshData, key)) {
          continue;
        }
        updates.push({ key, value: freshData[key] });
      }

      // Apply cache updates as a side effect (outside the React state updater).
      for (const { key, value } of updates) {
        if (value !== undefined) {
          cache.set(key, value);
        } else {
          cache.remove(key);
        }
      }

      // Then update React state (pure updater).
      setValues((prev) => {
        const next = { ...prev };
        for (const { key, value } of updates) {
          if (value !== undefined) {
            next[key] = value;
          } else {
            delete next[key];
          }
        }
        return next;
      });

      setStatus("loaded");
    } catch {
      if (requestId !== requestIdRef.current) return;
      setStatus("error");
    }
  }, [cache]);

  // Fetch on mount and when keys change (by value, not identity)
  React.useEffect(() => {
    if (skip) return;

    const currentKeys = keysRef.current;

    // Re-seed from cache for immediate values and prune removed keys.
    setValues((prev) => {
      const next: Record<string, T | undefined> = {};
      for (const key of currentKeys) {
        const existing = prev[key];
        if (existing !== undefined) {
          next[key] = existing;
          continue;
        }

        const cached = cache.get(key);
        if (cached !== null) {
          next[key] = cached;
        }
      }
      return next;
    });

    void doFetch();
  }, [skip, keysKey, cache, doFetch]);

  // Wrap refresh to be a void function (callers don't need to await)
  const refresh = React.useCallback(() => {
    void doFetch();
  }, [doFetch]);

  return { values, status, refresh };
}
