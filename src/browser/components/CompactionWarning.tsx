import React from "react";

/**
 * Warning banner shown when context usage is approaching the compaction threshold.
 *
 * Displays progressive warnings:
 * - Below threshold: "Context left until Auto-Compact: X% remaining" (where X = threshold - current)
 * - At/above threshold: "Approaching context limit. Next message will trigger auto-compaction."
 *
 * Displayed above ChatInput when:
 * - Token usage >= (threshold - 10%) of model's context window
 * - Not currently compacting (user can still send messages)
 *
 * @param usagePercentage - Current token usage as percentage (0-100)
 * @param thresholdPercentage - Auto-compaction trigger threshold (0-100, default 70)
 */
export const CompactionWarning: React.FC<{
  usagePercentage: number;
  thresholdPercentage: number;
}> = (props) => {
  // At threshold or above, next message will trigger compaction
  const willCompactNext = props.usagePercentage >= props.thresholdPercentage;

  // Urgent warning at/above threshold - prominent blue box
  if (willCompactNext) {
    return (
      <div className="text-plan-mode bg-plan-mode/10 mx-4 my-4 rounded-sm px-4 py-3 text-center text-xs font-medium">
        ⚠️ Context limit reached. Next message will trigger auto-compaction.
      </div>
    );
  }

  // Countdown warning below threshold - subtle grey text, right-aligned
  const remaining = props.thresholdPercentage - props.usagePercentage;
  return (
    <div className="text-muted mx-4 mt-2 mb-1 text-right text-[10px]">
      Context left until Auto-Compact: {Math.round(remaining)}%
    </div>
  );
};
