/**
 * Hook for tracking when hunk content addresses were first seen.
 * Used to sort hunks by "last edit at" (LIFO) in the Review panel.
 *
 * The hunk ID is already a content-based hash, so we use it as the content address.
 * We track the first time we see each hunk ID, which represents when the edit
 * that created this hunk content was first observed.
 */

import { useCallback, useRef } from "react";
import { usePersistedState } from "./usePersistedState";
import { getHunkFirstSeenKey } from "@/common/constants/storage";

/**
 * Maximum number of first-seen records to keep per workspace (LRU eviction)
 */
const MAX_FIRST_SEEN_RECORDS = 2048;

/**
 * First-seen timestamps keyed by hunk ID (content address)
 */
export interface HunkFirstSeenState {
  /** Hunk ID -> timestamp when first seen */
  firstSeen: Record<string, number>;
}

/**
 * Evict oldest entries if count exceeds max.
 * Keeps the newest maxCount entries by timestamp.
 */
function evictOldestEntries(
  firstSeen: Record<string, number>,
  maxCount: number
): Record<string, number> {
  const entries = Object.entries(firstSeen);
  if (entries.length <= maxCount) return firstSeen;

  // Sort by timestamp descending (newest first)
  entries.sort((a, b) => b[1] - a[1]);

  // Keep only the newest maxCount
  return Object.fromEntries(entries.slice(0, maxCount));
}

export interface UseHunkFirstSeenReturn {
  /** Get the first-seen timestamp for a hunk ID, or undefined if never seen */
  getFirstSeen: (hunkId: string) => number | undefined;

  /** Record first-seen timestamps for new hunk IDs (ignores already-seen IDs) */
  recordFirstSeen: (hunkIds: string[]) => void;

  /** Get all first-seen records (for sorting) */
  firstSeenMap: Record<string, number>;
}

/**
 * Hook for tracking when hunks were first seen in a workspace.
 * Automatically records first-seen timestamps and provides lookup.
 */
export function useHunkFirstSeen(workspaceId: string): UseHunkFirstSeenReturn {
  const [state, setState] = usePersistedState<HunkFirstSeenState>(
    getHunkFirstSeenKey(workspaceId),
    { firstSeen: {} }
  );

  // Track pending updates to batch them
  const pendingUpdatesRef = useRef<Set<string>>(new Set());
  const updateScheduledRef = useRef(false);

  const getFirstSeen = useCallback(
    (hunkId: string): number | undefined => {
      return state.firstSeen[hunkId];
    },
    [state.firstSeen]
  );

  const recordFirstSeen = useCallback(
    (hunkIds: string[]) => {
      // Add new IDs to pending set
      for (const id of hunkIds) {
        if (!(id in state.firstSeen)) {
          pendingUpdatesRef.current.add(id);
        }
      }

      // If we have pending updates and haven't scheduled yet, schedule a batch update
      if (pendingUpdatesRef.current.size > 0 && !updateScheduledRef.current) {
        updateScheduledRef.current = true;

        // Use microtask to batch multiple recordFirstSeen calls in same render
        queueMicrotask(() => {
          updateScheduledRef.current = false;
          const pending = pendingUpdatesRef.current;
          if (pending.size === 0) return;

          pendingUpdatesRef.current = new Set();
          const timestamp = Date.now();

          setState((prev) => {
            // Double-check which IDs are actually new (state may have changed)
            const newIds = Array.from(pending).filter((id) => !(id in prev.firstSeen));
            if (newIds.length === 0) return prev;

            const newFirstSeen = { ...prev.firstSeen };
            for (const id of newIds) {
              newFirstSeen[id] = timestamp;
            }

            // Apply LRU eviction if needed
            const evicted = evictOldestEntries(newFirstSeen, MAX_FIRST_SEEN_RECORDS);

            return { firstSeen: evicted };
          });
        });
      }
    },
    [state.firstSeen, setState]
  );

  return {
    getFirstSeen,
    recordFirstSeen,
    firstSeenMap: state.firstSeen,
  };
}
