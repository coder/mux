import React, { useCallback, useRef, useState } from "react";
import {
  AUTO_COMPACTION_THRESHOLD_MIN,
  AUTO_COMPACTION_THRESHOLD_MAX,
} from "@/common/constants/ui";
import { TooltipWrapper, Tooltip } from "../Tooltip";

// ----- Types -----

export interface AutoCompactionConfig {
  enabled: boolean;
  threshold: number;
  setEnabled: (enabled: boolean) => void;
  setThreshold: (threshold: number) => void;
}

type Orientation = "horizontal" | "vertical";

interface ThresholdSliderProps {
  config: AutoCompactionConfig;
  orientation: Orientation;
}

// ----- Constants -----

/** Threshold at which we consider auto-compaction disabled (dragged all the way right/down) */
const DISABLE_THRESHOLD = 100;

// ----- Hook: useDraggableThreshold -----

interface DragState {
  isDragging: boolean;
  dragValue: number | null;
}

function useDraggableThreshold(
  containerRef: React.RefObject<HTMLDivElement>,
  config: AutoCompactionConfig,
  orientation: Orientation
) {
  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    dragValue: null,
  });

  const calculatePercentage = useCallback(
    (clientX: number, clientY: number): number => {
      const container = containerRef.current;
      if (!container) return config.threshold;

      const rect = container.getBoundingClientRect();
      const raw =
        orientation === "horizontal"
          ? ((clientX - rect.left) / rect.width) * 100
          : ((clientY - rect.top) / rect.height) * 100;

      // Clamp and round to nearest 5
      const clamped = Math.max(AUTO_COMPACTION_THRESHOLD_MIN, Math.min(100, raw));
      return Math.round(clamped / 5) * 5;
    },
    [containerRef, orientation, config.threshold]
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

      const percentage = calculatePercentage(e.clientX, e.clientY);
      setDragState({ isDragging: true, dragValue: percentage });
      applyThreshold(percentage);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const newPercentage = calculatePercentage(moveEvent.clientX, moveEvent.clientY);
        setDragState({ isDragging: true, dragValue: newPercentage });
        applyThreshold(newPercentage);
      };

      const handleMouseUp = () => {
        setDragState({ isDragging: false, dragValue: null });
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [calculatePercentage, applyThreshold]
  );

  return { ...dragState, handleMouseDown };
}

// ----- Helper: compute display position -----

function computePosition(config: AutoCompactionConfig, dragValue: number | null): number {
  if (dragValue !== null) return dragValue;
  return config.enabled ? config.threshold : DISABLE_THRESHOLD;
}

// ----- Helper: tooltip text -----

function getTooltipText(
  config: AutoCompactionConfig,
  isDragging: boolean,
  dragValue: number | null,
  orientation: Orientation
): string {
  if (isDragging && dragValue !== null) {
    return dragValue >= DISABLE_THRESHOLD
      ? "Release to disable auto-compact"
      : `Auto-compact at ${dragValue}%`;
  }
  const direction = orientation === "horizontal" ? "left" : "up";
  return config.enabled
    ? `Auto-compact at ${config.threshold}% · Drag to adjust`
    : `Auto-compact disabled · Drag ${direction} to enable`;
}

// ----- Sub-components: Triangle indicators -----

interface TriangleProps {
  direction: "up" | "down" | "left" | "right";
  color: string;
  opacity: number;
}

const Triangle: React.FC<TriangleProps> = ({ direction, color, opacity }) => {
  const size = 4;
  const tipSize = 5;

  const styles: Record<TriangleProps["direction"], React.CSSProperties> = {
    up: {
      borderLeft: `${size}px solid transparent`,
      borderRight: `${size}px solid transparent`,
      borderBottom: `${tipSize}px solid ${color}`,
    },
    down: {
      borderLeft: `${size}px solid transparent`,
      borderRight: `${size}px solid transparent`,
      borderTop: `${tipSize}px solid ${color}`,
    },
    left: {
      borderTop: `${size}px solid transparent`,
      borderBottom: `${size}px solid transparent`,
      borderRight: `${tipSize}px solid ${color}`,
    },
    right: {
      borderTop: `${size}px solid transparent`,
      borderBottom: `${size}px solid transparent`,
      borderLeft: `${tipSize}px solid ${color}`,
    },
  };

  return <div style={{ width: 0, height: 0, opacity, ...styles[direction] }} />;
};

// ----- Sub-component: ThresholdIndicator -----

interface ThresholdIndicatorProps {
  position: number;
  color: string;
  opacity: number;
  orientation: Orientation;
}

const ThresholdIndicator: React.FC<ThresholdIndicatorProps> = ({
  position,
  color,
  opacity,
  orientation,
}) => {
  if (orientation === "horizontal") {
    return (
      <div
        className="pointer-events-none absolute flex flex-col items-center"
        style={{
          left: `${position}%`,
          top: -4,
          bottom: -4,
          transform: "translateX(-50%)",
        }}
      >
        <Triangle direction="down" color={color} opacity={opacity} />
        <div className="flex-1" style={{ width: 2, background: color, opacity }} />
        <Triangle direction="up" color={color} opacity={opacity} />
      </div>
    );
  }

  // Vertical
  return (
    <div
      className="pointer-events-none absolute flex items-center"
      style={{
        top: `${position}%`,
        left: -4,
        right: -4,
        transform: "translateY(-50%)",
      }}
    >
      <Triangle direction="right" color={color} opacity={opacity} />
      <div className="flex-1" style={{ height: 2, background: color, opacity }} />
      <Triangle direction="left" color={color} opacity={opacity} />
    </div>
  );
};

// ----- Main component -----

/**
 * ThresholdSlider renders an interactive threshold indicator overlay.
 *
 * IMPORTANT: This component must be placed inside a container with:
 * - `position: relative` (for absolute positioning)
 * - `overflow: visible` (so triangles can extend beyond bounds)
 *
 * The slider fills its container via `inset-0` and positions the indicator
 * line at the threshold percentage.
 */
export const ThresholdSlider: React.FC<ThresholdSliderProps> = ({ config, orientation }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { isDragging, dragValue, handleMouseDown } = useDraggableThreshold(
    containerRef,
    config,
    orientation
  );

  const position = computePosition(config, dragValue);
  const lineColor = config.enabled ? "var(--color-plan-mode)" : "var(--color-muted)";
  const opacity = isDragging ? 1 : 0.8;
  const tooltipText = getTooltipText(config, isDragging, dragValue, orientation);
  const cursor = orientation === "horizontal" ? "cursor-ew-resize" : "cursor-ns-resize";

  return (
    <TooltipWrapper>
      <div
        ref={containerRef}
        className={`absolute inset-0 z-10 ${cursor}`}
        onMouseDown={handleMouseDown}
      >
        <ThresholdIndicator
          position={position}
          color={lineColor}
          opacity={opacity}
          orientation={orientation}
        />
      </div>
      <Tooltip align="center" width="auto">
        {tooltipText}
      </Tooltip>
    </TooltipWrapper>
  );
};
