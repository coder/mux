import { useEffect, useState, useCallback } from "react";
import { useAPI } from "@/browser/contexts/API";

interface PostCompactionState {
  planPath: string | null;
  trackedFilePaths: string[];
  excludedItems: Set<string>;
  toggleExclusion: (itemId: string) => Promise<void>;
}

/**
 * Hook to fetch post-compaction context state for a workspace.
 * Returns info about what will be injected after compaction.
 */
export function usePostCompactionState(workspaceId: string): PostCompactionState {
  const { api } = useAPI();
  const [state, setState] = useState<{
    planPath: string | null;
    trackedFilePaths: string[];
    excludedItems: Set<string>;
  }>({
    planPath: null,
    trackedFilePaths: [],
    excludedItems: new Set(),
  });

  const fetchState = useCallback(async () => {
    if (!api) return;
    try {
      const result = await api.workspace.getPostCompactionState({ workspaceId });
      setState({
        planPath: result.planPath,
        trackedFilePaths: result.trackedFilePaths,
        excludedItems: new Set(result.excludedItems),
      });
    } catch {
      // Silently fail - component will show nothing if data unavailable
    }
  }, [api, workspaceId]);

  useEffect(() => {
    void fetchState();
    // Refetch periodically to stay up to date
    const interval = setInterval(() => void fetchState(), 5000);
    return () => clearInterval(interval);
  }, [fetchState]);

  const toggleExclusion = useCallback(
    async (itemId: string) => {
      if (!api) return;
      const isCurrentlyExcluded = state.excludedItems.has(itemId);
      const result = await api.workspace.setPostCompactionExclusion({
        workspaceId,
        itemId,
        excluded: !isCurrentlyExcluded,
      });
      if (result.success) {
        setState((prev) => {
          const newSet = new Set(prev.excludedItems);
          if (isCurrentlyExcluded) {
            newSet.delete(itemId);
          } else {
            newSet.add(itemId);
          }
          return { ...prev, excludedItems: newSet };
        });
      }
    },
    [api, workspaceId, state.excludedItems]
  );

  return { ...state, toggleExclusion };
}
