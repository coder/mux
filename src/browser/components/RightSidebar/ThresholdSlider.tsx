import React, { useRef } from "react";
import {
  AUTO_COMPACTION_THRESHOLD_MIN,
  AUTO_COMPACTION_THRESHOLD_MAX,
} from "@/common/constants/ui";

// ----- Types -----

export interface AutoCompactionConfig {
  threshold: number;
  setThreshold: (threshold: number) => void;
}

interface HorizontalThresholdSliderProps {
  config: AutoCompactionConfig;
}

// ----- Constants -----

/** Threshold at which we consider auto-compaction disabled (dragged all the way right) */
const DISABLE_THRESHOLD = 100;

/** Size of the triangle markers in pixels */
const TRIANGLE_SIZE = 4;

// ----- Subcomponents -----

/** CSS triangle pointing in specified direction */
const Triangle: React.FC<{ direction: "up" | "down"; color: string }> = ({ direction, color }) => (
  <div
    style={{
      width: 0,
      height: 0,
      borderLeft: `${TRIANGLE_SIZE}px solid transparent`,
      borderRight: `${TRIANGLE_SIZE}px solid transparent`,
      ...(direction === "down"
        ? { borderTop: `${TRIANGLE_SIZE}px solid ${color}` }
        : { borderBottom: `${TRIANGLE_SIZE}px solid ${color}` }),
    }}
  />
);

// ----- Main component: HorizontalThresholdSlider -----

/**
 * A draggable threshold indicator for horizontal progress bars.
 *
 * Renders as a vertical line with triangle handles at the threshold position.
 * Drag left/right to adjust threshold. Drag to 100% to disable.
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
export const HorizontalThresholdSlider: React.FC<HorizontalThresholdSliderProps> = ({ config }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const calcPercent = (clientX: number) => {
      const raw = ((clientX - rect.left) / rect.width) * 100;
      const clamped = Math.max(AUTO_COMPACTION_THRESHOLD_MIN, Math.min(100, raw));
      return Math.round(clamped / 5) * 5;
    };

    const applyThreshold = (pct: number) => {
      config.setThreshold(pct >= DISABLE_THRESHOLD ? 100 : Math.min(pct, AUTO_COMPACTION_THRESHOLD_MAX));
    };

    applyThreshold(calcPercent(e.clientX));

    const onMove = (ev: MouseEvent) => applyThreshold(calcPercent(ev.clientX));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const isEnabled = config.threshold < DISABLE_THRESHOLD;
  const color = isEnabled ? "var(--color-plan-mode)" : "var(--color-muted)";
  const title = isEnabled
    ? `Auto-compact at ${config.threshold}% · Drag to adjust (per-model)`
    : "Auto-compact disabled · Drag left to enable (per-model)";

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        cursor: "ew-resize",
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 50,
      }}
      onMouseDown={handleMouseDown}
      title={title}
    >
      {/* Indicator: top triangle + line + bottom triangle, centered on threshold */}
      <div
        style={{
          position: "absolute",
          left: `${config.threshold}%`,
          top: `calc(50% - ${TRIANGLE_SIZE + 3}px)`,
          transform: "translateX(-50%)",
          pointerEvents: "none",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <Triangle direction="down" color={color} />
        <div style={{ width: 1, height: 6, background: color }} />
        <Triangle direction="up" color={color} />
      </div>
    </div>
  );
};
