import React from "react";

/**
 * Animated background for compaction streaming
 * Shimmer effect with moving gradient and particles for dynamic appearance
 */

export const CompactionBackground: React.FC = () => {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-md">
      <div
        className="absolute inset-0 animate-[gradient-move_8s_ease_infinite] opacity-40"
        style={{
          background:
            "linear-gradient(-45deg, var(--color-plan-mode-alpha), color-mix(in srgb, var(--color-plan-mode) 30%, transparent), var(--color-plan-mode-alpha), color-mix(in srgb, var(--color-plan-mode) 25%, transparent))",
          backgroundSize: "400% 400%",
        }}
      />
      <div
        className="absolute inset-0 animate-[shimmer_3s_infinite_linear]"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, transparent 40%, var(--color-plan-mode-alpha) 50%, transparent 60%, transparent 100%)",
          backgroundSize: "1000px 100%",
        }}
      />
    </div>
  );
};
