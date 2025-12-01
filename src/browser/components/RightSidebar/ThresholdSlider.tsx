import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AUTO_COMPACTION_THRESHOLD_MIN,
  AUTO_COMPACTION_THRESHOLD_MAX,
} from "@/common/constants/ui";

// ----- Types -----

export interface AutoCompactionConfig {
  threshold: number;
  setThreshold: (threshold: number) => void;
}

interface ThresholdSliderProps {
  config: AutoCompactionConfig;
  orientation: "horizontal" | "vertical";
}

// ----- Constants -----

/** Threshold at which we consider auto-compaction disabled (dragged all the way to end) */
const DISABLE_THRESHOLD = 100;

/** Size of the triangle markers in pixels */
const TRIANGLE_SIZE = 4;

// ----- Subcomponents -----

/** CSS triangle pointing in specified direction */
const Triangle: React.FC<{ direction: "up" | "down" | "left" | "right"; color: string }> = ({
  direction,
  color,
}) => {
  const styles: React.CSSProperties = { width: 0, height: 0 };

  if (direction === "up" || direction === "down") {
    styles.borderLeft = `${TRIANGLE_SIZE}px solid transparent`;
    styles.borderRight = `${TRIANGLE_SIZE}px solid transparent`;
    if (direction === "down") {
      styles.borderTop = `${TRIANGLE_SIZE}px solid ${color}`;
    } else {
      styles.borderBottom = `${TRIANGLE_SIZE}px solid ${color}`;
    }
  } else {
    styles.borderTop = `${TRIANGLE_SIZE}px solid transparent`;
    styles.borderBottom = `${TRIANGLE_SIZE}px solid transparent`;
    if (direction === "right") {
      styles.borderLeft = `${TRIANGLE_SIZE}px solid ${color}`;
    } else {
      styles.borderRight = `${TRIANGLE_SIZE}px solid ${color}`;
    }
  }

  return <div style={styles} />;
};

// ----- Shared utilities -----

/** Clamp and snap percentage to valid threshold values */
const snapPercent = (raw: number): number => {
  const clamped = Math.max(AUTO_COMPACTION_THRESHOLD_MIN, Math.min(100, raw));
  return Math.round(clamped / 5) * 5;
};

/** Apply threshold, handling the disable case */
const applyThreshold = (pct: number, setThreshold: (v: number) => void): void => {
  setThreshold(pct >= DISABLE_THRESHOLD ? 100 : Math.min(pct, AUTO_COMPACTION_THRESHOLD_MAX));
};

/** Get tooltip text based on threshold */
const getTooltipText = (threshold: number, orientation: "horizontal" | "vertical"): string => {
  const isEnabled = threshold < DISABLE_THRESHOLD;
  const direction = orientation === "horizontal" ? "left" : "up";
  return isEnabled
    ? `Auto-compact at ${threshold}% · Drag to adjust (per-model)`
    : `Auto-compact disabled · Drag ${direction} to enable (per-model)`;
};

// ----- Portal Tooltip (vertical only) -----

interface VerticalSliderTooltipProps {
  text: string;
  anchorRect: DOMRect;
  threshold: number;
}

/**
 * Portal-based tooltip for vertical slider only.
 * Renders to document.body to escape the narrow container's clipping.
 * Horizontal slider uses native `title` attribute instead (simpler, no clipping issues).
 */
const VerticalSliderTooltip: React.FC<VerticalSliderTooltipProps> = ({
  text,
  anchorRect,
  threshold,
}) => {
  // Position to the left of the bar, aligned with threshold position
  const indicatorY = anchorRect.top + (anchorRect.height * threshold) / 100;

  const style: React.CSSProperties = {
    position: "fixed",
    zIndex: 9999,
    background: "#2d2d30",
    color: "#cccccc",
    padding: "6px 10px",
    borderRadius: 4,
    fontSize: 12,
    whiteSpace: "nowrap",
    pointerEvents: "none",
    boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
    right: window.innerWidth - anchorRect.left + 8,
    top: indicatorY,
    transform: "translateY(-50%)",
  };

  return createPortal(<div style={style}>{text}</div>, document.body);
};

// ----- Main component: ThresholdSlider -----

/**
 * A draggable threshold indicator for progress bars (horizontal or vertical).
 *
 * - Horizontal: Renders as a vertical line with up/down triangle handles.
 *   Drag left/right to adjust threshold. Drag to 100% (right) to disable.
 *
 * - Vertical: Renders as a horizontal line with left/right triangle handles.
 *   Drag up/down to adjust threshold. Drag to 100% (bottom) to disable.
 *
 * USAGE: Place as a sibling AFTER the progress bar, both inside a relative container.
 *
 * NOTE: This component uses inline styles instead of Tailwind classes intentionally.
 * When using Tailwind classes (e.g., `className="absolute cursor-ew-resize"`), the
 * component would intermittently fail to render or receive pointer events, despite
 * the React component mounting correctly. The root cause appears to be related to
 * how Tailwind's JIT compiler or class application interacts with dynamically
 * rendered components in this context. Inline styles work reliably.
 */
export const ThresholdSlider: React.FC<ThresholdSliderProps> = ({ config, orientation }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const isHorizontal = orientation === "horizontal";

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const calcPercent = (clientX: number, clientY: number) => {
      if (isHorizontal) {
        return snapPercent(((clientX - rect.left) / rect.width) * 100);
      } else {
        // Vertical: top = low %, bottom = high %
        return snapPercent(((clientY - rect.top) / rect.height) * 100);
      }
    };

    const apply = (pct: number) => applyThreshold(pct, config.setThreshold);

    apply(calcPercent(e.clientX, e.clientY));

    const onMove = (ev: MouseEvent) => apply(calcPercent(ev.clientX, ev.clientY));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const isEnabled = config.threshold < DISABLE_THRESHOLD;
  const color = isEnabled ? "var(--color-plan-mode)" : "var(--color-muted)";
  const tooltipText = getTooltipText(config.threshold, orientation);

  // Container styles
  const containerStyle: React.CSSProperties = {
    position: "absolute",
    cursor: isHorizontal ? "ew-resize" : "ns-resize",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 50,
  };

  // Indicator positioning - use transform for centering on both axes
  const indicatorStyle: React.CSSProperties = {
    position: "absolute",
    pointerEvents: "none",
    display: "flex",
    alignItems: "center",
    ...(isHorizontal
      ? {
          left: `${config.threshold}%`,
          top: "50%",
          transform: "translate(-50%, -50%)",
          flexDirection: "column",
        }
      : {
          top: `${config.threshold}%`,
          left: "50%",
          transform: "translate(-50%, -50%)",
          flexDirection: "row",
        }),
  };

  // Line between triangles
  const lineStyle: React.CSSProperties = isHorizontal
    ? { width: 1, height: 6, background: color }
    : { width: 6, height: 1, background: color };

  // Get container rect for tooltip positioning (vertical only)
  const containerRect = containerRef.current?.getBoundingClientRect();

  return (
    <div
      ref={containerRef}
      style={containerStyle}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      // Horizontal uses native title (simpler, no clipping issues with wide tooltips)
      title={isHorizontal ? tooltipText : undefined}
    >
      {/* Visual indicator - pointer events disabled */}
      <div style={indicatorStyle}>
        <Triangle direction={isHorizontal ? "down" : "right"} color={color} />
        <div style={lineStyle} />
        <Triangle direction={isHorizontal ? "up" : "left"} color={color} />
      </div>

      {/* Portal tooltip for vertical only - escapes narrow container clipping */}
      {!isHorizontal && isHovered && containerRect && (
        <VerticalSliderTooltip
          text={tooltipText}
          anchorRect={containerRect}
          threshold={config.threshold}
        />
      )}
    </div>
  );
};

// ----- Convenience exports -----

/** Horizontal threshold slider (alias for backwards compatibility) */
export const HorizontalThresholdSlider: React.FC<{ config: AutoCompactionConfig }> = ({
  config,
}) => <ThresholdSlider config={config} orientation="horizontal" />;

/** Vertical threshold slider */
export const VerticalThresholdSlider: React.FC<{ config: AutoCompactionConfig }> = ({ config }) => (
  <ThresholdSlider config={config} orientation="vertical" />
);
