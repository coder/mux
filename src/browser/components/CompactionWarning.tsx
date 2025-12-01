import React from "react";

/**
 * Warning indicator shown when context usage is approaching the compaction threshold.
 *
 * Displays as subtle right-aligned text:
 * - Below threshold: "Auto-Compact in X% usage" (where X = threshold - current)
 * - At/above threshold: Bold "Next message will Auto-Compact"
 *
 * Both states are clickable to insert /compact command.
 *
 * @param usagePercentage - Current token usage as percentage (0-100)
 * @param thresholdPercentage - Auto-compaction trigger threshold (0-100, default 70)
 * @param onCompactClick - Callback when user clicks to trigger manual compaction
 */
export const CompactionWarning: React.FC<{
  usagePercentage: number;
  thresholdPercentage: number;
  onCompactClick?: () => void;
}> = (props) => {
  // At threshold or above, next message will trigger compaction
  const willCompactNext = props.usagePercentage >= props.thresholdPercentage;
  const remaining = props.thresholdPercentage - props.usagePercentage;

  const text = willCompactNext
    ? "Next message will Auto-Compact"
    : `Auto-Compact in ${Math.round(remaining)}% usage`;

  return (
    <div className="mx-4 mt-2 mb-1 text-right text-[10px]">
      <button
        type="button"
        onClick={props.onCompactClick}
        className={`cursor-pointer hover:underline ${
          willCompactNext ? "text-plan-mode font-semibold" : "text-muted"
        }`}
        title="Click to insert /compact command"
      >
        {text}
      </button>
    </div>
  );
};
