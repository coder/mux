import React, { useState, useRef, useEffect } from "react";
import type { GitStatus } from "@/common/types/workspace";
import { GitStatusIndicatorView } from "./GitStatusIndicatorView";
import { useGitBranchDetails } from "./hooks/useGitBranchDetails";

interface GitStatusIndicatorProps {
  gitStatus: GitStatus | null;
  workspaceId: string;
  tooltipPosition?: "right" | "bottom";
}

/**
 * Container component for git status indicator.
 * Manages tooltip visibility, positioning, and data fetching.
 * Delegates rendering to GitStatusIndicatorView.
 */
export const GitStatusIndicator: React.FC<GitStatusIndicatorProps> = ({
  gitStatus,
  workspaceId,
  tooltipPosition = "right",
}) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipCoords, setTooltipCoords] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const trimmedWorkspaceId = workspaceId.trim();

  console.assert(
    trimmedWorkspaceId.length > 0,
    "GitStatusIndicator requires workspaceId to be a non-empty string."
  );

  // Fetch branch details only when tooltip should be shown
  const { branchHeaders, commits, dirtyFiles, isLoading, errorMessage } = useGitBranchDetails(
    trimmedWorkspaceId,
    gitStatus,
    showTooltip
  );

  const handleMouseEnter = () => {
    // Cancel any pending hide timeout
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }

    setShowTooltip(true);

    // Calculate tooltip position based on indicator position
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();

      if (tooltipPosition === "right") {
        // Position to the right of the indicator
        setTooltipCoords({
          top: rect.top + rect.height / 2,
          left: rect.right + 8,
        });
      } else {
        // Position below the indicator
        setTooltipCoords({
          top: rect.bottom + 8,
          left: rect.left,
        });
      }
    }
  };

  const handleMouseLeave = () => {
    // Delay hiding to give user time to move cursor to tooltip
    hideTimeoutRef.current = setTimeout(() => {
      setShowTooltip(false);
    }, 300);
  };

  const handleTooltipMouseEnter = () => {
    // Cancel hide timeout when hovering tooltip
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  };

  const handleTooltipMouseLeave = () => {
    // Hide immediately when leaving tooltip
    setShowTooltip(false);
  };

  const handleContainerRef = (el: HTMLSpanElement | null) => {
    containerRef.current = el;
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
    };
  }, []);

  return (
    <GitStatusIndicatorView
      gitStatus={gitStatus}
      tooltipPosition={tooltipPosition}
      branchHeaders={branchHeaders}
      commits={commits}
      dirtyFiles={dirtyFiles}
      isLoading={isLoading}
      errorMessage={errorMessage}
      showTooltip={showTooltip}
      tooltipCoords={tooltipCoords}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onTooltipMouseEnter={handleTooltipMouseEnter}
      onTooltipMouseLeave={handleTooltipMouseLeave}
      onContainerRef={handleContainerRef}
    />
  );
};
