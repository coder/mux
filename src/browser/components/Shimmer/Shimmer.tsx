"use client";

import { cn } from "@/common/lib/utils";
import type { ElementType } from "react";
import { memo } from "react";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
  colorClass?: string;
}

/**
 * Shimmer text effect using CSS background-clip: text.
 *
 * Uses a gradient background clipped to text shape, animated via
 * background-position. This is much lighter than the previous
 * canvas + Web Worker approach:
 * - No JS animation loop
 * - No canvas rendering
 * - No worker message passing
 * - Browser handles animation natively
 *
 * Note: background-position isn't compositor-only, but for small text
 * elements like "Thinking..." the repaint cost is negligible compared
 * to the overhead of canvas/worker solutions.
 */
const ShimmerComponent = ({
  children,
  as: Component = "span",
  className,
  duration = 2,
  colorClass = "var(--color-muted-foreground)",
}: TextShimmerProps) => {
  return (
    <Component
      className={cn("shimmer-text", className)}
      data-chromatic="ignore"
      style={
        {
          "--shimmer-duration": `${duration}s`,
          "--shimmer-color": colorClass,
        } as React.CSSProperties
      }
    >
      {children}
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
