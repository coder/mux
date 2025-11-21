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

  // Calculate remaining percentage until threshold
  const remaining = props.thresholdPercentage - props.usagePercentage;

  const message = willCompactNext
    ? "⚠️ Context limit reached. Next message will trigger auto-compaction."
    : `Context left until Auto-Compact: ${Math.round(remaining)}%`;

  return (
    <div className="text-plan-mode bg-plan-mode/10 mx-4 my-4 rounded-sm px-4 py-3 text-center text-xs font-medium">
      {message}
    </div>
  );
};
