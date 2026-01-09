import { useEffect, useState, useCallback } from "react";
import { useAPI } from "@/browser/contexts/API";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getPostCompactionStateKey } from "@/common/constants/storage";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";

interface PostCompactionState {
  planPath: string | null;
  trackedFilePaths: string[];
  excludedItems: Set<string>;
  toggleExclusion: (itemId: string) => Promise<void>;
}

interface CachedPostCompactionData {
  planPath: string | null;
  trackedFilePaths: string[];
  excludedItems: string[];
}

/**
 * Hook to get post-compaction context state for a workspace.
 * Fetches lazily from the backend API and caches in localStorage.
 * This avoids the expensive runtime.stat calls during workspace.list().
 * Only fetches when the POST_COMPACTION_CONTEXT experiment is enabled.
 */
export function usePostCompactionState(workspaceId: string): PostCompactionState {
  const { api } = useAPI();
  const experimentEnabled = useExperimentValue(EXPERIMENT_IDS.POST_COMPACTION_CONTEXT);

  // Initialize from cache for instant display
  const [state, setState] = useState<{
    planPath: string | null;
    trackedFilePaths: string[];
    excludedItems: Set<string>;
  }>(() => {
    const cached = readPersistedState<CachedPostCompactionData | null>(
      getPostCompactionStateKey(workspaceId),
      null
    );
    return {
      planPath: cached?.planPath ?? null,
      trackedFilePaths: cached?.trackedFilePaths ?? [],
      excludedItems: new Set(cached?.excludedItems ?? []),
    };
  });

  // Fetch fresh data when workspaceId changes (only if experiment enabled)
  useEffect(() => {
    if (!api || !experimentEnabled) return;

    let cancelled = false;
    const fetchState = async () => {
      try {
        const result = await api.workspace.getPostCompactionState({ workspaceId });
        if (cancelled) return;

        // Update state
        setState({
          planPath: result.planPath,
          trackedFilePaths: result.trackedFilePaths,
          excludedItems: new Set(result.excludedItems),
        });

        // Cache for next time
        updatePersistedState<CachedPostCompactionData>(getPostCompactionStateKey(workspaceId), {
          planPath: result.planPath,
          trackedFilePaths: result.trackedFilePaths,
          excludedItems: result.excludedItems,
        });
      } catch (error) {
        // Silently fail - use cached or empty state
        console.warn("[usePostCompactionState] Failed to fetch:", error);
      }
    };

    void fetchState();
    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, experimentEnabled]);

  const toggleExclusion = useCallback(
    async (itemId: string) => {
      if (!api || !experimentEnabled) return;
      const isCurrentlyExcluded = state.excludedItems.has(itemId);
      const result = await api.workspace.setPostCompactionExclusion({
        workspaceId,
        itemId,
        excluded: !isCurrentlyExcluded,
      });
      if (result.success) {
        // Optimistic update for immediate UI feedback
        setState((prev) => {
          const newSet = new Set(prev.excludedItems);
          if (isCurrentlyExcluded) {
            newSet.delete(itemId);
          } else {
            newSet.add(itemId);
          }
          const newState = { ...prev, excludedItems: newSet };

          // Update cache
          updatePersistedState<CachedPostCompactionData>(getPostCompactionStateKey(workspaceId), {
            planPath: newState.planPath,
            trackedFilePaths: newState.trackedFilePaths,
            excludedItems: Array.from(newSet),
          });

          return newState;
        });
      }
    },
    [api, workspaceId, state.excludedItems, experimentEnabled]
  );

  return { ...state, toggleExclusion };
}
