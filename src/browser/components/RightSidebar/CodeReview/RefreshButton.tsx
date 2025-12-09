/**
 * RefreshButton - Animated refresh button with graceful spin-down
 */

import React, { useState, useRef, useEffect } from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/ui/tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";

interface RefreshButtonProps {
  onClick: () => void;
  isLoading?: boolean;
}

export const RefreshButton: React.FC<RefreshButtonProps> = ({ onClick, isLoading = false }) => {
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

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            "flex items-center justify-center bg-transparent border-none p-0.5 transition-colors duration-[1500ms] ease-out",
            animationState === "spinning"
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
        {animationState !== "idle"
          ? "Refreshing..."
          : `Refresh diff (${formatKeybind(KEYBINDS.REFRESH_REVIEW)})`}
      </TooltipContent>
    </Tooltip>
  );
};
