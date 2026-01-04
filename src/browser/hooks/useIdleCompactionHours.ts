/**
 * Hook to manage idle compaction hours setting per project.
 *
 * Returns `null` when disabled, number of hours when enabled.
 * Persists to backend project config (where idleCompactionService reads it).
 */

import { useCallback, useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";

interface UseIdleCompactionHoursParams {
  /** Project path for backend persistence */
  projectPath: string | null;
}

export interface UseIdleCompactionHoursResult {
  /** Hours of inactivity before idle compaction triggers, or null if disabled */
  hours: number | null;
  /** Update the idle compaction hours setting (persists to backend) */
  setHours: (hours: number | null) => void;
}

/**
 * Hook for idle compaction hours setting.
 * - Setting is per-project (idle compaction is about workspace inactivity, not model context)
 * - null means disabled for that project
 * - Persists to backend so idleCompactionService can read it
 *
 * @param params - Object containing project path
 * @returns Settings object with hours value and setter
 */
export function useIdleCompactionHours(
  params: UseIdleCompactionHoursParams
): UseIdleCompactionHoursResult {
  const { projectPath } = params;
  const { api } = useAPI();
  const [hours, setHoursState] = useState<number | null>(null);

  // Load initial value from backend
  useEffect(() => {
    if (!projectPath || !api) return;
    let cancelled = false;
    void api.projects.idleCompaction.get({ projectPath }).then((result) => {
      if (!cancelled) {
        setHoursState(result.hours);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, projectPath]);

  // Setter that persists to backend
  const setHours = useCallback(
    (newHours: number | null) => {
      if (!projectPath || !api) return;
      const previousHours = hours;
      // Optimistic update
      setHoursState(newHours);
      // Persist to backend, revert on failure
      void api.projects.idleCompaction.set({ projectPath, hours: newHours }).then((result) => {
        if (!result.success) {
          setHoursState(previousHours);
        }
      });
    },
    [api, projectPath, hours]
  );

  return { hours, setHours };
}
