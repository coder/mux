import { usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getAutoCompactionEnabledKey,
  getAutoCompactionThresholdKey,
} from "@/common/constants/storage";
import { DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT } from "@/common/constants/ui";

export interface AutoCompactionSettings {
  /** Whether auto-compaction is enabled for this workspace */
  enabled: boolean;
  /** Update enabled state */
  setEnabled: (value: boolean) => void;
  /** Current threshold percentage (50-90) */
  threshold: number;
  /** Update threshold percentage (will be clamped to 50-90 range by UI) */
  setThreshold: (value: number) => void;
}

/**
 * Custom hook for auto-compaction settings per workspace.
 * Persists both enabled state and threshold percentage to localStorage.
 *
 * @param workspaceId - Workspace identifier
 * @returns Settings object with getters and setters
 */
export function useAutoCompactionSettings(workspaceId: string): AutoCompactionSettings {
  const [enabled, setEnabled] = usePersistedState<boolean>(
    getAutoCompactionEnabledKey(workspaceId),
    true,
    { listener: true }
  );

  const [threshold, setThreshold] = usePersistedState<number>(
    getAutoCompactionThresholdKey(workspaceId),
    DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT,
    { listener: true }
  );

  return { enabled, setEnabled, threshold, setThreshold };
}
