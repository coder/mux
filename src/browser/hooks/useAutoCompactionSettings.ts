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
 * Custom hook for auto-compaction settings.
 * - Enabled state is per-workspace
 * - Threshold is per-model (different models have different context windows)
 *
 * @param workspaceId - Workspace identifier for enabled state
 * @param model - Model identifier for threshold (e.g., "claude-sonnet-4-5")
 * @returns Settings object with getters and setters
 */
export function useAutoCompactionSettings(
  workspaceId: string,
  model: string | null
): AutoCompactionSettings {
  const [enabled, setEnabled] = usePersistedState<boolean>(
    getAutoCompactionEnabledKey(workspaceId),
    true,
    { listener: true }
  );

  // Use model for threshold key, fall back to "default" if no model
  const thresholdKey = getAutoCompactionThresholdKey(model ?? "default");
  const [threshold, setThreshold] = usePersistedState<number>(
    thresholdKey,
    DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT,
    { listener: true }
  );

  return { enabled, setEnabled, threshold, setThreshold };
}
