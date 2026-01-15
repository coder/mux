import React from "react";

import { cn } from "@/common/lib/utils";

import { LogoBlinkHopping } from "./LogoBlinkHopping";

interface LoadingIndicatorProps {
  size?: number;
  animate?: boolean | "once";
  className?: string;
  ariaLabel?: string;
}

/**
 * Canonical loading indicator for the desktop app.
 *
 * Prefer this over bespoke spinners (CSS borders, spinning lucide icons) and
 * ellipsis animations.
 */
export const LoadingIndicator: React.FC<LoadingIndicatorProps> = ({
  size = 16,
  animate = true,
  className,
  ariaLabel = "Loading",
}) => {
  return (
    <span
      className={cn("inline-flex items-center justify-center", className)}
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">{ariaLabel}</span>
      <LogoBlinkHopping size={size} animate={animate} />
    </span>
  );
};
