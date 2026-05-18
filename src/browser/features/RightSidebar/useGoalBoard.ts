import { useCallback, useEffect, useState } from "react";

import { useAPI } from "@/browser/contexts/API";
import type { GoalBoardSnapshot } from "@/common/types/goal";

/**
 * React hook for the GoalTab board (multi-goal queue). Subscribes to
 * the API's `workspace.getGoalBoard` endpoint and exposes a
 * stable `refresh()` callback so board mutations (add / archive /
 * revive / reorder / promote) can trigger a re-read inline.
 *
 * Always returns a value: while the initial fetch is in flight we serve
 * an empty board so the UI doesn't flash null. `isLoading` flips false
 * after the first resolution.
 *
 * Note: we deliberately don't subscribe to workspace activity events
 * here — board mutations are user-initiated through this hook's
 * callbacks (or transparent auto-promotion after a setGoal/clear, which
 * the existing activity snapshot pipeline already nudges). A future
 * tighter coupling could push board snapshots through the activity
 * channel; today's reads are cheap enough to drive on-demand.
 */
export interface UseGoalBoardResult {
  board: GoalBoardSnapshot;
  isLoading: boolean;
  refresh: () => void;
}

export function useGoalBoard(workspaceId: string | undefined): UseGoalBoardResult {
  const { api } = useAPI();
  const [board, setBoard] = useState<GoalBoardSnapshot>({ entries: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!api || !workspaceId) {
      setBoard({ entries: [] });
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void api.workspace
      .getGoalBoard({ workspaceId })
      .then((snapshot) => {
        if (cancelled) return;
        setBoard(snapshot ?? { entries: [] });
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setBoard({ entries: [] });
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return { board, isLoading, refresh };
}
