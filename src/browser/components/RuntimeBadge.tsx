import React from "react";
import { cn } from "@/common/lib/utils";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime, isWorktreeRuntime, isLocalProjectRuntime } from "@/common/types/runtime";
import { extractSshHostname } from "@/browser/utils/ui/runtimeBadge";
import { TooltipWrapper, Tooltip } from "./Tooltip";

interface RuntimeBadgeProps {
  runtimeConfig?: RuntimeConfig;
  className?: string;
  /** When true, shows blue pulsing styling to indicate agent is working */
  isWorking?: boolean;
}

/** Server rack icon for SSH runtime */
function SSHIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="SSH Runtime"
    >
      <rect x="2" y="2" width="12" height="5" rx="1" />
      <rect x="2" y="9" width="12" height="5" rx="1" />
      <circle cx="5" cy="4.5" r="0.5" fill="currentColor" />
      <circle cx="5" cy="11.5" r="0.5" fill="currentColor" />
    </svg>
  );
}

/** Git branch icon for worktree runtime */
function WorktreeIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Worktree Runtime"
    >
      {/* Simplified git branch: vertical line with branch off */}
      <circle cx="8" cy="3" r="2" />
      <circle cx="8" cy="13" r="2" />
      <line x1="8" y1="5" x2="8" y2="11" />
      <circle cx="12" cy="7" r="2" />
      <path d="M10 7 L8 9" />
    </svg>
  );
}

/** Folder icon for local project-dir runtime */
function LocalIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Local Runtime"
    >
      {/* Folder icon */}
      <path d="M2 4 L2 13 L14 13 L14 5 L8 5 L7 3 L2 3 L2 4" />
    </svg>
  );
}

/**
 * Badge to display runtime type information.
 * Shows icon-only badge with tooltip describing the runtime type.
 * - SSH: server icon with hostname
 * - Worktree: git branch icon (isolated worktree)
 * - Local: folder icon (project directory)
 *
 * When isWorking=true, badges show blue color with pulse animation.
 * When idle, badges show gray styling.
 */
export function RuntimeBadge({ runtimeConfig, className, isWorking = false }: RuntimeBadgeProps) {
  // Dynamic styling based on working state
  const workingStyles = isWorking
    ? "bg-blue-500/20 text-blue-400 border-blue-500/40 animate-pulse"
    : "bg-muted/30 text-muted border-muted/50";

  // SSH runtime: show server icon with hostname
  if (isSSHRuntime(runtimeConfig)) {
    const hostname = extractSshHostname(runtimeConfig);
    return (
      <TooltipWrapper inline>
        <span
          className={cn(
            "inline-flex items-center rounded px-1 py-0.5 border transition-colors",
            workingStyles,
            className
          )}
        >
          <SSHIcon />
        </span>
        <Tooltip align="right">SSH: {hostname ?? runtimeConfig.host}</Tooltip>
      </TooltipWrapper>
    );
  }

  // Worktree runtime: show git branch icon
  if (isWorktreeRuntime(runtimeConfig)) {
    return (
      <TooltipWrapper inline>
        <span
          className={cn(
            "inline-flex items-center rounded px-1 py-0.5 border transition-colors",
            workingStyles,
            className
          )}
        >
          <WorktreeIcon />
        </span>
        <Tooltip align="right">Worktree: isolated git worktree</Tooltip>
      </TooltipWrapper>
    );
  }

  // Local project-dir runtime: show folder icon
  if (isLocalProjectRuntime(runtimeConfig)) {
    return (
      <TooltipWrapper inline>
        <span
          className={cn(
            "inline-flex items-center rounded px-1 py-0.5 border transition-colors",
            workingStyles,
            className
          )}
        >
          <LocalIcon />
        </span>
        <Tooltip align="right">Local: project directory</Tooltip>
      </TooltipWrapper>
    );
  }

  return null;
}
