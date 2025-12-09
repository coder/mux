import { useEffect, useState, useCallback } from "react";
import { useAPI } from "@/browser/contexts/API";

interface PostCompactionState {
  planPath: string | null;
  trackedFilePaths: string[];
}

/**
 * Hook to fetch post-compaction context state for a workspace.
 * Returns info about what will be injected after compaction.
 */
export function usePostCompactionState(workspaceId: string): PostCompactionState {
  const { api } = useAPI();
  const [state, setState] = useState<PostCompactionState>({
    planPath: null,
    trackedFilePaths: [],
  });

  const fetchState = useCallback(async () => {
    if (!api) return;
    try {
      const result = await api.workspace.getPostCompactionState({ workspaceId });
      setState({
        planPath: result.planPath,
        trackedFilePaths: result.trackedFilePaths,
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

  return state;
}
