import React from "react";
import { cn } from "@/common/lib/utils";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime, isWorktreeRuntime, isLocalProjectRuntime } from "@/common/types/runtime";
import { extractSshHostname } from "@/browser/utils/ui/runtimeBadge";
import { TooltipWrapper, Tooltip } from "./Tooltip";
import { SSHIcon, WorktreeIcon, LocalIcon } from "./icons/RuntimeIcons";

interface RuntimeBadgeProps {
  runtimeConfig?: RuntimeConfig;
  className?: string;
  /** When true, shows blue pulsing styling to indicate agent is working */
  isWorking?: boolean;
}

// Runtime-specific color schemes - each type has consistent colors in idle/working states
// Idle: subtle with visible colored border for discrimination
// Working: brighter colors with pulse animation
const RUNTIME_STYLES = {
  ssh: {
    idle: "bg-transparent text-muted border-blue-500/50",
    working: "bg-blue-500/20 text-blue-400 border-blue-500/60 animate-pulse",
  },
  worktree: {
    idle: "bg-transparent text-muted border-purple-500/50",
    working: "bg-purple-500/20 text-purple-400 border-purple-500/60 animate-pulse",
  },
  local: {
    idle: "bg-transparent text-muted border-muted/50",
    working: "bg-muted/30 text-muted border-muted/60 animate-pulse",
  },
} as const;

/**
 * Badge to display runtime type information.
 * Shows icon-only badge with tooltip describing the runtime type.
 * - SSH: server icon with hostname (blue theme)
 * - Worktree: git branch icon (purple theme)
 * - Local: folder icon (gray theme)
 *
 * When isWorking=true, badges brighten and pulse within their color scheme.
 */
export function RuntimeBadge({ runtimeConfig, className, isWorking = false }: RuntimeBadgeProps) {
  // SSH runtime: show server icon with hostname
  if (isSSHRuntime(runtimeConfig)) {
    const hostname = extractSshHostname(runtimeConfig);
    const styles = isWorking ? RUNTIME_STYLES.ssh.working : RUNTIME_STYLES.ssh.idle;
    return (
      <TooltipWrapper inline>
        <span
          className={cn(
            "inline-flex items-center rounded px-1 py-0.5 border transition-colors",
            styles,
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
    const styles = isWorking ? RUNTIME_STYLES.worktree.working : RUNTIME_STYLES.worktree.idle;
    return (
      <TooltipWrapper inline>
        <span
          className={cn(
            "inline-flex items-center rounded px-1 py-0.5 border transition-colors",
            styles,
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
    const styles = isWorking ? RUNTIME_STYLES.local.working : RUNTIME_STYLES.local.idle;
    return (
      <TooltipWrapper inline>
        <span
          className={cn(
            "inline-flex items-center rounded px-1 py-0.5 border transition-colors",
            styles,
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
