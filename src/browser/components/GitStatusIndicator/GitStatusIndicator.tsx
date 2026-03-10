import React, { useState, useCallback } from "react";
import type { GitStatus } from "@/common/types/workspace";
import { GIT_STATUS_INDICATOR_MODE_KEY } from "@/common/constants/storage";
import { STORAGE_KEYS, WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { invalidateGitStatus, useGitStatusRefreshing } from "@/browser/stores/GitStatusStore";
import {
  GitStatusIndicatorView,
  type GitStatusIndicatorMode,
} from "../GitStatusIndicatorView/GitStatusIndicatorView";
import { useGitBranchDetails } from "@/browser/features/Hooks/useGitBranchDetails";

interface GitStatusIndicatorProps {
  gitStatus: GitStatus | null;
  workspaceId: string;
  projectPath: string;
  tooltipPosition?: "right" | "bottom";
  /** When true, shows blue pulsing styling to indicate agent is working */
  isWorking?: boolean;
  /**
   * When false, hide line-delta (+/-) counts and lock the indicator to commit divergence.
   * Useful in dense lists (for example the left sidebar agent rows) where +/− noise hurts scanability.
   */
  showLineDelta?: boolean;
}

/**
 * Container component for git status indicator.
 * Manages dialog visibility and data fetching.
 * Delegates rendering to GitStatusIndicatorView.
 */
export const GitStatusIndicator: React.FC<GitStatusIndicatorProps> = ({
  gitStatus,
  workspaceId,
  projectPath,
  tooltipPosition = "right",
  isWorking = false,
  showLineDelta = true,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const trimmedWorkspaceId = workspaceId.trim();
  const isRefreshing = useGitStatusRefreshing(trimmedWorkspaceId);

  const [mode, setMode] = usePersistedState<GitStatusIndicatorMode>(
    GIT_STATUS_INDICATOR_MODE_KEY,
    "line-delta",
    { listener: true }
  );
  const effectiveMode: GitStatusIndicatorMode = showLineDelta ? mode : "divergence";

  // Per-project default base (fallback for new workspaces)
  const [projectDefaultBase] = usePersistedState<string>(
    STORAGE_KEYS.reviewDefaultBase(projectPath),
    WORKSPACE_DEFAULTS.reviewBase,
    { listener: true }
  );

  // Per-workspace base ref (shared with review panel, syncs via listener)
  const [baseRef, setBaseRef] = usePersistedState<string>(
    STORAGE_KEYS.reviewDiffBase(trimmedWorkspaceId),
    projectDefaultBase,
    { listener: true }
  );

  const handleBaseChange = useCallback(
    (value: string) => {
      setBaseRef(value);
      invalidateGitStatus(trimmedWorkspaceId);
    },
    [setBaseRef, trimmedWorkspaceId]
  );

  const handleModeChange = useCallback(
    (nextMode: GitStatusIndicatorMode) => {
      if (!showLineDelta) {
        return;
      }
      setMode(nextMode);
    },
    [setMode, showLineDelta]
  );

  console.assert(
    trimmedWorkspaceId.length > 0,
    "GitStatusIndicator requires workspaceId to be a non-empty string."
  );

  // Fetch branch details only while the divergence dialog is open
  const { branchHeaders, commits, dirtyFiles, isLoading, errorMessage } = useGitBranchDetails(
    trimmedWorkspaceId,
    gitStatus,
    isOpen
  );

  return (
    <GitStatusIndicatorView
      mode={effectiveMode}
      allowLineDelta={showLineDelta}
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
      baseRef={baseRef}
      onBaseChange={handleBaseChange}
      isWorking={isWorking}
      isRefreshing={isRefreshing}
    />
  );
};
