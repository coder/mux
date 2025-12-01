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
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { getModelStats } from "@/common/utils/tokens/modelStats";
import { supports1MContext } from "@/common/utils/ai/models";
import {
  DEFAULT_AUTO_COMPACTION_THRESHOLD,
  FORCE_COMPACTION_TOKEN_BUFFER,
} from "@/common/constants/ui";

/** Sum all token components from a ChatUsageDisplay */
function getTotalTokens(usage: ChatUsageDisplay): number {
  return (
    usage.input.tokens +
    usage.cached.tokens +
    usage.cacheCreate.tokens +
    usage.output.tokens +
    usage.reasoning.tokens
  );
}

export interface AutoCompactionCheckResult {
  shouldShowWarning: boolean;
  /** True when live usage shows ≤FORCE_COMPACTION_TOKEN_BUFFER remaining in context */
  shouldForceCompact: boolean;
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
 * @param threshold - Usage percentage threshold (0.0-1.0, default 0.7 = 70%). If >= 1.0, auto-compaction is considered disabled.
 * @param warningAdvancePercent - Show warning this many percentage points before threshold (default 10)
 * @returns Check result with warning flag and usage percentage
 */
export function checkAutoCompaction(
  usage: WorkspaceUsageState | undefined,
  model: string | null,
  use1M: boolean,
  threshold: number = DEFAULT_AUTO_COMPACTION_THRESHOLD,
  warningAdvancePercent: number = WARNING_ADVANCE_PERCENT
): AutoCompactionCheckResult {
  const thresholdPercentage = threshold * 100;
  const isEnabled = threshold < 1.0;

  // Short-circuit if auto-compaction is disabled or missing required data
  if (!isEnabled || !model || !usage) {
    return {
      shouldShowWarning: false,
      shouldForceCompact: false,
      usagePercentage: 0,
      thresholdPercentage,
    };
  }

  // Determine max tokens for this model
  const modelStats = getModelStats(model);
  const maxTokens = use1M && supports1MContext(model) ? 1_000_000 : modelStats?.max_input_tokens;

  // No max tokens known - safe default (can't calculate percentage)
  if (!maxTokens) {
    return {
      shouldShowWarning: false,
      shouldForceCompact: false,
      usagePercentage: 0,
      thresholdPercentage,
    };
  }

  // Current usage: live when streaming, else last historical (pattern from CostsTab)
  const lastUsage = usage.usageHistory[usage.usageHistory.length - 1];
  const currentUsage = usage.liveUsage ?? lastUsage;

  // Force-compact when approaching context limit (can trigger even with empty history if streaming)
  let shouldForceCompact = false;
  if (currentUsage) {
    const remainingTokens = maxTokens - getTotalTokens(currentUsage);
    shouldForceCompact = remainingTokens <= FORCE_COMPACTION_TOKEN_BUFFER;
  }

  // Warning/percentage based on lastUsage (completed requests only)
  if (!lastUsage) {
    return {
      shouldShowWarning: false,
      shouldForceCompact,
      usagePercentage: 0,
      thresholdPercentage,
    };
  }

  const usagePercentage = (getTotalTokens(lastUsage) / maxTokens) * 100;
  const shouldShowWarning = usagePercentage >= thresholdPercentage - warningAdvancePercent;

  return {
    shouldShowWarning,
    shouldForceCompact,
    usagePercentage,
    thresholdPercentage,
  };
}
