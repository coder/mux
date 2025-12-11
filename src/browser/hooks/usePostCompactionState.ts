import { useEffect, useState, useCallback, useMemo } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";

interface PostCompactionState {
  planPath: string | null;
  trackedFilePaths: string[];
  excludedItems: Set<string>;
  toggleExclusion: (itemId: string) => Promise<void>;
}

/**
 * Hook to get post-compaction context state for a workspace.
 * Reads bundled state from workspace metadata (loaded with includePostCompaction flag).
 * Falls back to empty state if experiment is disabled or data unavailable.
 */
export function usePostCompactionState(workspaceId: string): PostCompactionState {
  const { api } = useAPI();
  const { workspaceMetadata } = useWorkspaceContext();

  // Get bundled state from metadata (may be undefined if experiment disabled)
  const bundledState = useMemo(() => {
    const metadata = workspaceMetadata.get(workspaceId);
    return metadata?.postCompaction;
  }, [workspaceMetadata, workspaceId]);

  const [state, setState] = useState<{
    planPath: string | null;
    trackedFilePaths: string[];
    excludedItems: Set<string>;
  }>(() => ({
    planPath: bundledState?.planPath ?? null,
    trackedFilePaths: bundledState?.trackedFilePaths ?? [],
    excludedItems: new Set(bundledState?.excludedItems ?? []),
  }));

  // Sync when bundled state changes (workspace switch or metadata refresh)
  // Clear to empty state when bundledState is undefined (experiment disabled)
  useEffect(() => {
    setState({
      planPath: bundledState?.planPath ?? null,
      trackedFilePaths: bundledState?.trackedFilePaths ?? [],
      excludedItems: new Set(bundledState?.excludedItems ?? []),
    });
  }, [bundledState]);

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
        // Optimistic update for immediate UI feedback
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
