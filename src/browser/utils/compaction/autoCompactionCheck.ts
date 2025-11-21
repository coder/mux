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
}

// Show warning this many percentage points before threshold
const WARNING_ADVANCE_PERCENT = 10;

/**
 * Check if auto-compaction should trigger based on token usage
 *
 * Uses the last usage entry (most recent API call) to calculate current context size.
 * This matches the UI token meter display and excludes historical usage from compaction,
 * preventing infinite compaction loops after the first compaction completes.
 *
 * @param usage - Current workspace usage state (from useWorkspaceUsage)
 * @param model - Current model string (optional - returns safe default if not provided)
 * @param use1M - Whether 1M context is enabled
 * @param enabled - Whether auto-compaction is enabled for this workspace
 * @param threshold - Usage percentage threshold (0.0-1.0, default 0.7 = 70%)
 * @param warningAdvancePercent - Show warning this many percentage points before threshold (default 10)
 * @returns Check result with warning flag and usage percentage
 */
export function checkAutoCompaction(
  usage: WorkspaceUsageState | undefined,
  model: string | null,
  use1M: boolean,
  enabled: boolean,
  threshold: number = DEFAULT_AUTO_COMPACTION_THRESHOLD,
  warningAdvancePercent: number = WARNING_ADVANCE_PERCENT
): AutoCompactionCheckResult {
  const thresholdPercentage = threshold * 100;

  // Short-circuit if auto-compaction is disabled
  // Or if no usage data yet
  if (!enabled || !model || !usage || usage.usageHistory.length === 0) {
    return {
      shouldShowWarning: false,
      usagePercentage: 0,
      thresholdPercentage,
    };
  }

  // Determine max tokens for this model
  const modelStats = getModelStats(model);
  const maxTokens = use1M && supports1MContext(model) ? 1_000_000 : modelStats?.max_input_tokens;
  const lastUsage = usage.usageHistory[usage.usageHistory.length - 1];

  // No max tokens known - safe default (can't calculate percentage)
  if (!maxTokens) {
    return {
      shouldShowWarning: false,
      usagePercentage: 0,
      thresholdPercentage,
    };
  }

  const currentContextTokens =
    lastUsage.input.tokens +
    lastUsage.cached.tokens +
    lastUsage.cacheCreate.tokens +
    lastUsage.output.tokens +
    lastUsage.reasoning.tokens;

  const usagePercentage = (currentContextTokens / maxTokens) * 100;

  // Show warning if within advance window (e.g., 60% for 70% threshold with 10% advance)
  const shouldShowWarning = usagePercentage >= thresholdPercentage - warningAdvancePercent;

  return {
    shouldShowWarning,
    usagePercentage,
    thresholdPercentage,
  };
}
