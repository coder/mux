/**
 * Hook to manage idle compaction hours setting per model.
 *
 * Returns `null` when disabled, number of hours when enabled.
 * Stored in localStorage per-model (like auto-compaction threshold).
 */

import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { getIdleCompactionHoursKey } from "@/common/constants/storage";

interface UseIdleCompactionHoursParams {
  /** Model identifier for per-model storage (e.g., "claude-sonnet-4-5") */
  model: string | null;
}

export interface UseIdleCompactionHoursResult {
  /** Hours of inactivity before idle compaction triggers, or null if disabled */
  hours: number | null;
  /** Update the idle compaction hours setting */
  setHours: (hours: number | null) => void;
}

/**
 * Hook for idle compaction hours setting.
 * - Setting is per-model (different models have different context windows)
 * - null means disabled for that model
 *
 * @param params - Object containing model identifier
 * @returns Settings object with hours value and setter
 */
export function useIdleCompactionHours(
  params: UseIdleCompactionHoursParams
): UseIdleCompactionHoursResult {
  const { model } = params;
  // Use model for storage key, fall back to "default" if no model
  const storageKey = getIdleCompactionHoursKey(model ?? "default");
  const [hours, setHours] = usePersistedState<number | null>(storageKey, null, { listener: true });

  return { hours, setHours };
}
