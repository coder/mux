/**
 * RefreshButton - Animated refresh button with graceful spin-down
 */

import React, { useState, useRef, useEffect } from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/ui/tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { formatRelativeTimeCompact } from "@/browser/utils/ui/dateTime";
import { cn } from "@/common/lib/utils";
import type { LastRefreshInfo, RefreshTrigger } from "@/browser/utils/RefreshController";

interface RefreshButtonProps {
  onClick: () => void;
  isLoading?: boolean;
  /** Debug info about last refresh (timestamp and trigger) */
  lastRefreshInfo?: LastRefreshInfo | null;
  /** Whether the button should be disabled (e.g., user composing review note) */
  disabled?: boolean;
}

/** Human-readable trigger labels */
const TRIGGER_LABELS: Record<RefreshTrigger, string> = {
  manual: "manual click",
  scheduled: "tool completion",
  priority: "tool completion (priority)",
  focus: "window focus",
  visibility: "tab visible",
  unpaused: "interaction ended",
  "in-flight-followup": "queued followup",
};

export const RefreshButton: React.FC<RefreshButtonProps> = (props) => {
  const { onClick, isLoading = false, lastRefreshInfo, disabled = false } = props;
  // Track animation state for graceful stopping
  const [animationState, setAnimationState] = useState<"idle" | "spinning" | "stopping">("idle");
  const spinOnceTimeoutRef = useRef<number | null>(null);

  // Watch isLoading changes and manage animation transitions
  useEffect(() => {
    if (isLoading) {
      // Start spinning
      setAnimationState("spinning");
      // Clear any pending stop timeout
      if (spinOnceTimeoutRef.current) {
        clearTimeout(spinOnceTimeoutRef.current);
        spinOnceTimeoutRef.current = null;
      }
    } else if (animationState === "spinning") {
      // Gracefully stop: do one final rotation
      setAnimationState("stopping");
      // After animation completes, return to idle
      spinOnceTimeoutRef.current = window.setTimeout(() => {
        setAnimationState("idle");
        spinOnceTimeoutRef.current = null;
      }, 800); // Match animation duration
    }
  }, [isLoading, animationState]);

  // Cleanup timeout on unmount only
  useEffect(() => {
    return () => {
      if (spinOnceTimeoutRef.current) {
        clearTimeout(spinOnceTimeoutRef.current);
      }
    };
  }, []);

  const handleClick = () => {
    if (disabled) return;

    // Manual refresh should always provide immediate feedback, even if the refresh
    // resolves too quickly for isLoading to visibly flip.
    if (!isLoading) {
      setAnimationState("spinning");
      if (spinOnceTimeoutRef.current) {
        clearTimeout(spinOnceTimeoutRef.current);
        spinOnceTimeoutRef.current = null;
      }
    }

    onClick();
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label="Refresh diff"
          data-testid="review-refresh"
          data-last-refresh-trigger={lastRefreshInfo?.trigger ?? ""}
          data-last-refresh-timestamp={lastRefreshInfo?.timestamp ?? ""}
          data-disabled={disabled || undefined}
          disabled={disabled}
          onClick={handleClick}
          className={cn(
            "flex items-center justify-center bg-transparent border-none p-0.5 transition-colors duration-[1500ms] ease-out",
            disabled
              ? "text-muted/40 cursor-not-allowed"
              : animationState === "spinning"
                ? "text-accent cursor-default hover:text-accent"
                : "text-muted cursor-pointer hover:text-foreground",
            animationState === "stopping" && "cursor-default"
          )}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={cn(
              "w-3 h-3",
              animationState === "spinning" && "animate-spin",
              animationState === "stopping" && "animate-[spin_0.8s_ease-out_forwards]"
            )}
          >
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        {disabled ? (
          "Finish editing review note to refresh"
        ) : animationState !== "idle" ? (
          "Refreshing..."
        ) : (
          <span>
            Refresh diff ({formatKeybind(KEYBINDS.REFRESH_REVIEW)})
            {lastRefreshInfo && (
              <span className="text-muted block text-[10px]">
                Last: {formatRelativeTimeCompact(lastRefreshInfo.timestamp)} via{" "}
                {TRIGGER_LABELS[lastRefreshInfo.trigger] ?? lastRefreshInfo.trigger}
              </span>
            )}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
};
