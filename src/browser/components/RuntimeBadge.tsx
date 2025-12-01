import React from "react";
import { cn } from "@/common/lib/utils";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime, isWorktreeRuntime, isLocalProjectRuntime } from "@/common/types/runtime";
import { extractSshHostname } from "@/browser/utils/ui/runtimeBadge";
import { TooltipWrapper, Tooltip } from "./Tooltip";

interface RuntimeBadgeProps {
  runtimeConfig?: RuntimeConfig;
  className?: string;
}

/** Server rack icon for SSH runtime */
function SSHIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="SSH Runtime"
    >
      <rect x="2" y="2" width="12" height="4" rx="1" />
      <rect x="2" y="10" width="12" height="4" rx="1" />
      <line x1="5" y1="4" x2="5" y2="4" />
      <line x1="5" y1="12" x2="5" y2="12" />
    </svg>
  );
}

/** Git branch icon for worktree runtime */
function WorktreeIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Worktree Runtime"
    >
      {/* Git branch icon */}
      <circle cx="5" cy="4" r="2" />
      <circle cx="11" cy="4" r="2" />
      <circle cx="5" cy="12" r="2" />
      <line x1="5" y1="6" x2="5" y2="10" />
      <path d="M5 8 C 5 4 11 8 11 6" />
    </svg>
  );
}

/** Folder icon for local project-dir runtime (reserved for future use) */
function _LocalIcon() {
  return (
    <svg
      width="12"
      height="12"
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
 * - Local: folder icon (project directory, no badge shown by default)
 */
export function RuntimeBadge({ runtimeConfig, className }: RuntimeBadgeProps) {
  // SSH runtime: show server icon with hostname
  if (isSSHRuntime(runtimeConfig)) {
    const hostname = extractSshHostname(runtimeConfig);
    return (
      <TooltipWrapper inline>
        <span
          className={cn(
            "inline-flex items-center rounded px-1 py-0.5",
            "bg-accent/10 text-accent border border-accent/30",
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
            "inline-flex items-center rounded px-1 py-0.5",
            "bg-muted/50 text-muted-foreground border border-muted",
            className
          )}
        >
          <WorktreeIcon />
        </span>
        <Tooltip align="right">Worktree: isolated git worktree</Tooltip>
      </TooltipWrapper>
    );
  }

  // Local project-dir runtime: don't show badge (it's the simplest/default)
  // Could optionally show LocalIcon if we want visibility
  if (isLocalProjectRuntime(runtimeConfig)) {
    return null; // No badge for simple local runtimes
  }

  return null;
}
