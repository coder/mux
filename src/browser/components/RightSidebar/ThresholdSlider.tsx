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
  /** Height of the bar for vertical positioning (horizontal orientation only) */
  barHeight?: number;
}

// Threshold at which we consider auto-compaction disabled (dragged all the way right/down)
const DISABLE_THRESHOLD = 100;

export const ThresholdSlider: React.FC<ThresholdSliderProps> = ({
  threshold,
  enabled,
  onThresholdChange,
  onEnabledChange,
  orientation,
  barHeight = 6,
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
    // Render as a positioned overlay - the parent should have position:relative
    return (
      <TooltipWrapper inline>
        <div
          ref={containerRef}
          className="absolute cursor-ew-resize"
          style={{
            left: 0,
            right: 0,
            top: "50%",
            transform: "translateY(-50%)",
            height: barHeight + 16, // bar + 8px padding each side for easier grabbing
          }}
          onMouseDown={handleMouseDown}
        >
          {/* Vertical line indicator with grab handle */}
          <div
            className="pointer-events-none absolute flex flex-col items-center"
            style={{
              left: `${position}%`,
              transform: "translateX(-50%)",
              top: 0,
              bottom: 0,
            }}
          >
            {/* Top handle - small triangle */}
            <div
              className={`h-0 w-0 shrink-0 transition-opacity ${
                isDragging ? "opacity-100" : "opacity-70"
              }`}
              style={{
                borderLeft: "4px solid transparent",
                borderRight: "4px solid transparent",
                borderTop: `5px solid ${enabled ? "var(--color-plan-mode)" : "var(--color-muted)"}`,
              }}
            />
            {/* The line itself */}
            <div
              className={`flex-1 transition-opacity ${isDragging ? "opacity-100" : "opacity-70"}`}
              style={{
                width: 2,
                background: enabled ? "var(--color-plan-mode)" : "var(--color-muted)",
              }}
            />
            {/* Bottom handle - small triangle pointing up */}
            <div
              className={`h-0 w-0 shrink-0 transition-opacity ${
                isDragging ? "opacity-100" : "opacity-70"
              }`}
              style={{
                borderLeft: "4px solid transparent",
                borderRight: "4px solid transparent",
                borderBottom: `5px solid ${enabled ? "var(--color-plan-mode)" : "var(--color-muted)"}`,
              }}
            />
          </div>
        </div>
        <Tooltip align="center" width="auto">
          {tooltipContent}
        </Tooltip>
      </TooltipWrapper>
    );
  }

  // Vertical orientation
  return (
    <TooltipWrapper inline>
      <div
        ref={containerRef}
        className="absolute cursor-ns-resize"
        style={{
          top: 0,
          bottom: 0,
          left: "50%",
          transform: "translateX(-50%)",
          width: 20, // wider hit area
        }}
        onMouseDown={handleMouseDown}
      >
        {/* Horizontal line indicator with grab handles */}
        <div
          className="pointer-events-none absolute flex items-center"
          style={{
            top: `${position}%`,
            transform: "translateY(-50%)",
            left: 0,
            right: 0,
          }}
        >
          {/* Left handle - small triangle */}
          <div
            className={`h-0 w-0 shrink-0 transition-opacity ${
              isDragging ? "opacity-100" : "opacity-70"
            }`}
            style={{
              borderTop: "4px solid transparent",
              borderBottom: "4px solid transparent",
              borderLeft: `5px solid ${enabled ? "var(--color-plan-mode)" : "var(--color-muted)"}`,
            }}
          />
          {/* The line itself */}
          <div
            className={`flex-1 transition-opacity ${isDragging ? "opacity-100" : "opacity-70"}`}
            style={{
              height: 2,
              background: enabled ? "var(--color-plan-mode)" : "var(--color-muted)",
            }}
          />
          {/* Right handle - small triangle pointing left */}
          <div
            className={`h-0 w-0 shrink-0 transition-opacity ${
              isDragging ? "opacity-100" : "opacity-70"
            }`}
            style={{
              borderTop: "4px solid transparent",
              borderBottom: "4px solid transparent",
              borderRight: `5px solid ${enabled ? "var(--color-plan-mode)" : "var(--color-muted)"}`,
            }}
          />
        </div>
      </div>
      <Tooltip align="center" width="auto">
        {tooltipContent}
      </Tooltip>
    </TooltipWrapper>
  );
};
