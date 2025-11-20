/**
 * Auto-compaction threshold checking
 *
 * Determines whether auto-compaction should trigger based on current token usage
 * as a percentage of the model's context window.
 *
 * Auto-compaction triggers when:
 * - Usage data is available (has at least one API response)
 * - Model has known max_input_tokens
 * - Usage exceeds threshold (default 70%)
 *
 * Safe defaults:
 * - Returns false if no usage data (first message)
 * - Returns false if model stats unavailable (unknown model)
 * - Never triggers in edit mode (caller's responsibility to check)
 */

import type { WorkspaceUsageState } from "@/browser/stores/WorkspaceStore";
import { getModelStats } from "@/common/utils/tokens/modelStats";
import { supports1MContext } from "@/common/utils/ai/models";
import { DEFAULT_AUTO_COMPACTION_THRESHOLD } from "@/common/constants/ui";

export interface AutoCompactionCheckResult {
  shouldShowWarning: boolean;
  usagePercentage: number;
  thresholdPercentage: number;
  enabled: boolean;
}

// Show warning this many percentage points before threshold
const WARNING_ADVANCE_PERCENT = 10;

/**
 * Check if auto-compaction should trigger based on token usage
 *
 * @param usage - Current workspace usage state (from useWorkspaceUsage)
 * @param model - Current model string (optional - returns safe default if not provided)
 * @param use1M - Whether 1M context is enabled
 * @param enabled - Whether auto-compaction is enabled for this workspace
 * @param threshold - Usage percentage threshold (0.0-1.0, default 0.7 = 70%)
 * @param warningAdvancePercent - Show warning this many percentage points before threshold (default 10)
 * @returns Check result with warning flag and usage percentage
 */
export function shouldAutoCompact(
  usage: WorkspaceUsageState | undefined,
  model: string | null | undefined,
  use1M: boolean,
  enabled = true,
  threshold: number = DEFAULT_AUTO_COMPACTION_THRESHOLD,
  warningAdvancePercent: number = WARNING_ADVANCE_PERCENT
): AutoCompactionCheckResult {
  const thresholdPercentage = threshold * 100;

  // Short-circuit if auto-compaction is disabled
  if (!enabled || !model) {
    return {
      shouldShowWarning: false,
      usagePercentage: 0,
      thresholdPercentage,
      enabled: false,
    };
  }

  // No usage data yet - safe default (don't trigger on first message)
  if (!usage || usage.usageHistory.length === 0) {
    return {
      shouldShowWarning: false,
      usagePercentage: 0,
      thresholdPercentage,
      enabled: true,
    };
  }

  // Determine max tokens for this model
  const modelStats = getModelStats(model);
  const maxTokens = use1M && supports1MContext(model) ? 1_000_000 : modelStats?.max_input_tokens;

  // No max tokens known - safe default (can't calculate percentage)
  if (!maxTokens) {
    return {
      shouldShowWarning: false,
      usagePercentage: 0,
      thresholdPercentage,
      enabled: true,
    };
  }

  // Calculate usage percentage from cumulative conversation total
  const usagePercentage = (usage.totalTokens / maxTokens) * 100;

  // Show warning if within advance window (e.g., 60% for 70% threshold with 10% advance)
  const shouldShowWarning = usagePercentage >= thresholdPercentage - warningAdvancePercent;

  return {
    shouldShowWarning,
    usagePercentage,
    thresholdPercentage,
    enabled: true,
  };
}
