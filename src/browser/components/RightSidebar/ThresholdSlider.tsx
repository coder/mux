import React, { useCallback, useRef, useState } from "react";
import {
  AUTO_COMPACTION_THRESHOLD_MIN,
  AUTO_COMPACTION_THRESHOLD_MAX,
} from "@/common/constants/ui";

// ----- Types -----

export interface AutoCompactionConfig {
  enabled: boolean;
  threshold: number;
  setEnabled: (enabled: boolean) => void;
  setThreshold: (threshold: number) => void;
}

interface HorizontalThresholdSliderProps {
  config: AutoCompactionConfig;
}

// ----- Constants -----

/** Threshold at which we consider auto-compaction disabled (dragged all the way right) */
const DISABLE_THRESHOLD = 100;

// ----- Main component: HorizontalThresholdSlider -----

/**
 * A draggable threshold indicator for horizontal progress bars.
 *
 * Renders as a vertical line with triangle handles at the threshold position.
 * Drag left/right to adjust threshold. Drag to 100% to disable.
 *
 * USAGE: Place as a sibling AFTER the progress bar, both inside a relative container.
 */
export const HorizontalThresholdSlider: React.FC<HorizontalThresholdSliderProps> = ({ config }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragValue, setDragValue] = useState<number | null>(null);

  // Current display position
  const position = dragValue ?? (config.enabled ? config.threshold : DISABLE_THRESHOLD);

  const calculatePercentage = useCallback(
    (clientX: number): number => {
      const container = containerRef.current;
      if (!container) return config.threshold;

      const rect = container.getBoundingClientRect();
      const raw = ((clientX - rect.left) / rect.width) * 100;
      const clamped = Math.max(AUTO_COMPACTION_THRESHOLD_MIN, Math.min(100, raw));
      return Math.round(clamped / 5) * 5;
    },
    [config.threshold]
  );

  const applyThreshold = useCallback(
    (percentage: number) => {
      if (percentage >= DISABLE_THRESHOLD) {
        config.setEnabled(false);
      } else {
        if (!config.enabled) config.setEnabled(true);
        config.setThreshold(Math.min(percentage, AUTO_COMPACTION_THRESHOLD_MAX));
      }
    },
    [config]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const percentage = calculatePercentage(e.clientX);
      setIsDragging(true);
      setDragValue(percentage);
      applyThreshold(percentage);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const newPercentage = calculatePercentage(moveEvent.clientX);
        setDragValue(newPercentage);
        applyThreshold(newPercentage);
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        setDragValue(null);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [calculatePercentage, applyThreshold]
  );

  // Tooltip text
  const title = isDragging
    ? dragValue !== null && dragValue >= DISABLE_THRESHOLD
      ? "Release to disable auto-compact"
      : `Auto-compact at ${dragValue}%`
    : config.enabled
    ? `Auto-compact at ${config.threshold}% · Drag to adjust`
    : "Auto-compact disabled · Drag left to enable";

  const lineColor = config.enabled
    ? "var(--color-plan-mode)"
    : "var(--color-muted)";
  const opacity = isDragging ? 1 : 0.8;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-10"
      style={{ pointerEvents: "none" }} // pass clicks through the empty parts of the container if needed, but we want the hit area to catch them
    >
      {/* Hit Area - Wider than the bar for easier grabbing */}
      <div
        className="absolute cursor-ew-resize"
        style={{
          top: -12, // Extend 12px up
          bottom: -12, // Extend 12px down
          left: 0,
          right: 0,
          pointerEvents: "auto", // Re-enable pointer events for the hit area
          zIndex: 20,
        }}
        onMouseDown={handleMouseDown}
        title={title}
      />

      {/* Visual Indicator - Strictly positioned relative to the bar (containerRef) */}
      <div
        className="pointer-events-none absolute flex flex-col items-center"
        style={{
          left: `${position}%`,
          top: -4, // Visual overshoot top
          bottom: -4, // Visual overshoot bottom
          transform: "translateX(-50%)",
          zIndex: 10,
        }}
      >
        {/* Top triangle (pointing down) */}
        <div
          style={{
            width: 0,
            height: 0,
            borderLeft: "4px solid transparent",
            borderRight: "4px solid transparent",
            borderTop: `5px solid ${lineColor}`,
            opacity,
          }}
        />
        {/* Line */}
        <div style={{ flex: 1, width: 2, background: lineColor, opacity }} />
        {/* Bottom triangle (pointing up) */}
        <div
          style={{
            width: 0,
            height: 0,
            borderLeft: "4px solid transparent",
            borderRight: "4px solid transparent",
            borderBottom: `5px solid ${lineColor}`,
            opacity,
          }}
        />
      </div>
    </div>
  );
};
