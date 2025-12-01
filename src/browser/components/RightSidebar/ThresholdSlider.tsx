import React, { useCallback, useRef, useState } from "react";
import {
  AUTO_COMPACTION_THRESHOLD_MIN,
  AUTO_COMPACTION_THRESHOLD_MAX,
} from "@/common/constants/ui";
import { TooltipWrapper, Tooltip } from "../Tooltip";

interface ThresholdSliderProps {
  /** Current threshold percentage (50-90, or 100 for disabled) */
  threshold: number;
  /** Whether auto-compaction is enabled */
  enabled: boolean;
  /** Callback when threshold changes */
  onThresholdChange: (threshold: number) => void;
  /** Callback when enabled state changes */
  onEnabledChange: (enabled: boolean) => void;
  /** Orientation of the slider */
  orientation: "horizontal" | "vertical";
}

// Threshold at which we consider auto-compaction disabled (dragged all the way right/down)
const DISABLE_THRESHOLD = 100;

export const ThresholdSlider: React.FC<ThresholdSliderProps> = ({
  threshold,
  enabled,
  onThresholdChange,
  onEnabledChange,
  orientation,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragValue, setDragValue] = useState<number | null>(null);

  // Calculate position from threshold (50-100 -> 50%-100%)
  const effectiveThreshold = enabled ? threshold : DISABLE_THRESHOLD;
  const position = isDragging && dragValue !== null ? dragValue : effectiveThreshold;

  const updateThreshold = useCallback(
    (clientX: number, clientY: number) => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      let percentage: number;

      if (orientation === "horizontal") {
        percentage = ((clientX - rect.left) / rect.width) * 100;
      } else {
        // Vertical: top = low %, bottom = high %
        percentage = ((clientY - rect.top) / rect.height) * 100;
      }

      // Clamp to valid range
      percentage = Math.max(AUTO_COMPACTION_THRESHOLD_MIN, Math.min(100, percentage));

      // Round to nearest 5 for nice values
      percentage = Math.round(percentage / 5) * 5;

      // Update visual position during drag
      setDragValue(percentage);

      if (percentage >= DISABLE_THRESHOLD) {
        // Dragged to end - disable auto-compaction
        onEnabledChange(false);
      } else {
        // Within valid range - update threshold and ensure enabled
        if (!enabled) {
          onEnabledChange(true);
        }
        onThresholdChange(Math.min(percentage, AUTO_COMPACTION_THRESHOLD_MAX));
      }
    },
    [orientation, enabled, onThresholdChange, onEnabledChange]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      updateThreshold(e.clientX, e.clientY);

      const handleMouseMove = (e: MouseEvent) => {
        updateThreshold(e.clientX, e.clientY);
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
    [updateThreshold]
  );

  // Tooltip shows live feedback during drag
  const tooltipContent = isDragging
    ? dragValue !== null && dragValue >= DISABLE_THRESHOLD
      ? "Release to disable auto-compact"
      : `Auto-compact at ${dragValue ?? threshold}%`
    : enabled
      ? `Auto-compact at ${threshold}% · Drag to adjust`
      : "Auto-compact disabled · Drag left to enable";

  if (orientation === "horizontal") {
    return (
      <div
        ref={containerRef}
        className="absolute inset-0 cursor-ew-resize"
        onMouseDown={handleMouseDown}
      >
        <TooltipWrapper inline>
          {/* Vertical line indicator - extends above and below the bar */}
          <div
            className={`pointer-events-none absolute transition-opacity ${
              isDragging ? "opacity-100" : "opacity-60 hover:opacity-100"
            } ${enabled ? "bg-plan-mode" : "bg-muted"}`}
            style={{
              left: `${position}%`,
              transform: "translateX(-50%)",
              width: "2px",
              top: "-4px",
              bottom: "-4px",
            }}
          />
          <Tooltip align="center" width="auto">
            {tooltipContent}
          </Tooltip>
        </TooltipWrapper>
      </div>
    );
  }

  // Vertical orientation
  return (
    <div
      ref={containerRef}
      className="absolute inset-0 cursor-ns-resize"
      onMouseDown={handleMouseDown}
    >
      <TooltipWrapper inline>
        {/* Horizontal line indicator - extends left and right of the bar */}
        <div
          className={`pointer-events-none absolute transition-opacity ${
            isDragging ? "opacity-100" : "opacity-60 hover:opacity-100"
          } ${enabled ? "bg-plan-mode" : "bg-muted"}`}
          style={{
            top: `${position}%`,
            transform: "translateY(-50%)",
            height: "2px",
            left: "-2px",
            right: "-2px",
          }}
        />
        <Tooltip align="center" width="auto">
          {tooltipContent}
        </Tooltip>
      </TooltipWrapper>
    </div>
  );
};
