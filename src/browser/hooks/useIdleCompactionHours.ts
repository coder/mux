/**
 * Hook to manage idle compaction hours setting per project.
 *
 * Returns `null` when disabled, number of hours when enabled.
 * Persists to backend project config (where idleCompactionService reads it).
 */

import { useCallback, useEffect, useRef, useState } from "react";
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

  // Guards for out-of-order async responses (e.g., rapid toggles or project switches).
  const currentProjectPathRef = useRef<string | null>(projectPath);
  currentProjectPathRef.current = projectPath;
  const latestSaveRequestIdRef = useRef(0);

  // Load initial value from backend
  useEffect(() => {
    if (!projectPath || !api) return;
    let cancelled = false;
    void api.projects.idleCompaction
      .get({ projectPath })
      .then((result) => {
        if (!cancelled) {
          setHoursState(result.hours);
        }
      })
      .catch(() => {
        // Ignore load errors; leaving state unchanged avoids clobbering newer
        // values when switching projects quickly.
      });
    return () => {
      cancelled = true;
    };
  }, [api, projectPath]);

  // Setter that persists to backend
  const setHours = useCallback(
    (newHours: number | null) => {
      if (!projectPath || !api) return;
      const requestId = ++latestSaveRequestIdRef.current;

      const previousHours = hours;
      const projectPathAtCall = projectPath;

      // Optimistic update
      setHoursState(newHours);

      // Persist to backend, revert on failure (including rejected IPC calls).
      void api.projects.idleCompaction
        .set({ projectPath: projectPathAtCall, hours: newHours })
        .then((result) => {
          if (!result.success) {
            throw new Error(result.error ?? "Failed to set idle compaction hours");
          }
        })
        .catch(() => {
          // Only revert if this is still the latest update for the current project.
          if (latestSaveRequestIdRef.current !== requestId) return;
          if (currentProjectPathRef.current !== projectPathAtCall) return;
          setHoursState(previousHours);
        });
    },
    [api, projectPath, hours]
  );

  return { hours, setHours };
}
