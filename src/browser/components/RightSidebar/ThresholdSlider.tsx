import React, { useCallback, useRef, useState } from "react";
import {
  AUTO_COMPACTION_THRESHOLD_MIN,
  AUTO_COMPACTION_THRESHOLD_MAX,
} from "@/common/constants/ui";

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
      e.stopPropagation();
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

  // Tooltip text
  const tooltipText = isDragging
    ? dragValue !== null && dragValue >= DISABLE_THRESHOLD
      ? "Release to disable auto-compact"
      : `Auto-compact at ${dragValue ?? threshold}%`
    : enabled
      ? `Auto-compact at ${threshold}% · Drag to adjust`
      : "Auto-compact disabled · Drag left to enable";

  const lineColor = enabled ? "var(--color-plan-mode)" : "var(--color-muted)";

  if (orientation === "horizontal") {
    // Absolute overlay covering the bar area
    return (
      <div
        ref={containerRef}
        className="absolute inset-0 cursor-ew-resize"
        style={{ zIndex: 10 }}
        onMouseDown={handleMouseDown}
        title={tooltipText}
      >
        {/* Vertical line indicator with triangles */}
        <div
          className="pointer-events-none absolute"
          style={{
            left: `${position}%`,
            top: -4,
            bottom: -4,
            transform: "translateX(-50%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          {/* Top triangle */}
          <div
            style={{
              width: 0,
              height: 0,
              borderLeft: "4px solid transparent",
              borderRight: "4px solid transparent",
              borderTop: `5px solid ${lineColor}`,
              opacity: isDragging ? 1 : 0.8,
            }}
          />
          {/* Line */}
          <div
            style={{
              flex: 1,
              width: 2,
              background: lineColor,
              opacity: isDragging ? 1 : 0.8,
            }}
          />
          {/* Bottom triangle */}
          <div
            style={{
              width: 0,
              height: 0,
              borderLeft: "4px solid transparent",
              borderRight: "4px solid transparent",
              borderBottom: `5px solid ${lineColor}`,
              opacity: isDragging ? 1 : 0.8,
            }}
          />
        </div>
      </div>
    );
  }

  // Vertical orientation - absolute overlay
  return (
    <div
      ref={containerRef}
      className="absolute inset-0 cursor-ns-resize"
      style={{ zIndex: 10 }}
      onMouseDown={handleMouseDown}
      title={tooltipText}
    >
      {/* Horizontal line indicator with triangles */}
      <div
        className="pointer-events-none absolute"
        style={{
          top: `${position}%`,
          left: -3,
          right: -3,
          transform: "translateY(-50%)",
          display: "flex",
          alignItems: "center",
        }}
      >
        {/* Left triangle */}
        <div
          style={{
            width: 0,
            height: 0,
            borderTop: "4px solid transparent",
            borderBottom: "4px solid transparent",
            borderLeft: `5px solid ${lineColor}`,
            opacity: isDragging ? 1 : 0.8,
          }}
        />
        {/* Line */}
        <div
          style={{
            flex: 1,
            height: 2,
            background: lineColor,
            opacity: isDragging ? 1 : 0.8,
          }}
        />
        {/* Right triangle */}
        <div
          style={{
            width: 0,
            height: 0,
            borderTop: "4px solid transparent",
            borderBottom: "4px solid transparent",
            borderRight: `5px solid ${lineColor}`,
            opacity: isDragging ? 1 : 0.8,
          }}
        />
      </div>
    </div>
  );
};
