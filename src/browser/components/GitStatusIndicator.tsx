import React, { useState, useCallback } from "react";
import type { GitStatus } from "@/common/types/workspace";
import { GIT_STATUS_INDICATOR_MODE_KEY } from "@/common/constants/storage";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useGitStatusRefreshing } from "@/browser/stores/GitStatusStore";
import { GitStatusIndicatorView, type GitStatusIndicatorMode } from "./GitStatusIndicatorView";
import { useGitBranchDetails } from "./hooks/useGitBranchDetails";

interface GitStatusIndicatorProps {
  gitStatus: GitStatus | null;
  workspaceId: string;
  tooltipPosition?: "right" | "bottom";
  /** When true, shows blue pulsing styling to indicate agent is working */
  isWorking?: boolean;
}

/**
 * Container component for git status indicator.
 * Manages hover card visibility and data fetching.
 * Delegates rendering to GitStatusIndicatorView.
 */
export const GitStatusIndicator: React.FC<GitStatusIndicatorProps> = ({
  gitStatus,
  workspaceId,
  tooltipPosition = "right",
  isWorking = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const trimmedWorkspaceId = workspaceId.trim();
  const isRefreshing = useGitStatusRefreshing(trimmedWorkspaceId);

  const [mode, setMode] = usePersistedState<GitStatusIndicatorMode>(
    GIT_STATUS_INDICATOR_MODE_KEY,
    "line-delta",
    { listener: true }
  );

  const handleModeChange = useCallback(
    (nextMode: GitStatusIndicatorMode) => {
      setMode(nextMode);
    },
    [setMode]
  );

  console.assert(
    trimmedWorkspaceId.length > 0,
    "GitStatusIndicator requires workspaceId to be a non-empty string."
  );

  // Fetch branch details only when hover card is open
  const { branchHeaders, commits, dirtyFiles, isLoading, errorMessage } = useGitBranchDetails(
    trimmedWorkspaceId,
    gitStatus,
    isOpen
  );

  return (
    <GitStatusIndicatorView
      mode={mode}
      gitStatus={gitStatus}
      tooltipPosition={tooltipPosition}
      branchHeaders={branchHeaders}
      commits={commits}
      dirtyFiles={dirtyFiles}
      isLoading={isLoading}
      errorMessage={errorMessage}
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      onModeChange={handleModeChange}
      isWorking={isWorking}
      isRefreshing={isRefreshing}
    />
  );
};
