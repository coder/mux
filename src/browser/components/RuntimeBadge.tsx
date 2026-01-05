import React from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/common/lib/utils";
import type { RuntimeConfig } from "@/common/types/runtime";
import {
  isSSHRuntime,
  isWorktreeRuntime,
  isLocalProjectRuntime,
  isDockerRuntime,
} from "@/common/types/runtime";
import { extractSshHostname } from "@/browser/utils/ui/runtimeBadge";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { SSHIcon, WorktreeIcon, LocalIcon, DockerIcon } from "./icons/RuntimeIcons";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";

interface RuntimeBadgeProps {
  runtimeConfig?: RuntimeConfig;
  className?: string;
  /** When true, shows blue pulsing styling to indicate agent is working */
  isWorking?: boolean;
  /** Workspace path to show in tooltip */
  workspacePath?: string;
  /** Git branch/workspace name to show in tooltip */
  branchName?: string;
}

// Runtime-specific color schemes - each type has consistent colors in idle/working states
// Colors use CSS variables (--color-runtime-*) so they adapt to theme (e.g., solarized)
// Idle: subtle with visible colored border for discrimination
// Working: brighter colors with pulse animation
const RUNTIME_STYLES = {
  ssh: {
    idle: "bg-transparent text-muted border-[var(--color-runtime-ssh)]/50",
    working:
      "bg-[var(--color-runtime-ssh)]/20 text-[var(--color-runtime-ssh-text)] border-[var(--color-runtime-ssh)]/60 animate-pulse",
  },
  worktree: {
    idle: "bg-transparent text-muted border-[var(--color-runtime-worktree)]/50",
    working:
      "bg-[var(--color-runtime-worktree)]/20 text-[var(--color-runtime-worktree-text)] border-[var(--color-runtime-worktree)]/60 animate-pulse",
  },
  local: {
    idle: "bg-transparent text-muted border-[var(--color-runtime-local)]/50",
    working:
      "bg-[var(--color-runtime-local)]/30 text-[var(--color-runtime-local)] border-[var(--color-runtime-local)]/60 animate-pulse",
  },
  docker: {
    idle: "bg-transparent text-muted border-[var(--color-runtime-docker)]/50",
    working:
      "bg-[var(--color-runtime-docker)]/20 text-[var(--color-runtime-docker-text)] border-[var(--color-runtime-docker)]/60 animate-pulse",
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
function PathWithCopy({ path }: { path: string }) {
  const { copied, copyToClipboard } = useCopyToClipboard();

  return (
    <div className="mt-1 flex items-center gap-1">
      <span className="text-muted font-mono text-[10px]">{path}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          void copyToClipboard(path);
        }}
        className="text-muted hover:text-foreground"
        aria-label="Copy path"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}

function BranchWithLabel({ branchName }: { branchName: string }) {
  return (
    <div className="mt-1 flex max-w-80 items-baseline gap-1">
      <span className="text-muted shrink-0">Branch:</span>
      <span className="min-w-0 font-mono break-words">{branchName}</span>
    </div>
  );
}

export function RuntimeBadge({
  runtimeConfig,
  className,
  isWorking = false,
  workspacePath,
  branchName,
}: RuntimeBadgeProps) {
  // SSH runtime: show server icon with hostname
  if (isSSHRuntime(runtimeConfig)) {
    const hostname = extractSshHostname(runtimeConfig);
    const styles = isWorking ? RUNTIME_STYLES.ssh.working : RUNTIME_STYLES.ssh.idle;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center rounded px-1 py-0.5 border transition-colors",
              styles,
              className
            )}
          >
            <SSHIcon />
          </span>
        </TooltipTrigger>
        <TooltipContent align="end">
          <div>SSH: {hostname ?? runtimeConfig.host}</div>
          {branchName && <BranchWithLabel branchName={branchName} />}
          {workspacePath && <PathWithCopy path={workspacePath} />}
        </TooltipContent>
      </Tooltip>
    );
  }

  // Worktree runtime: show git branch icon
  if (isWorktreeRuntime(runtimeConfig)) {
    const styles = isWorking ? RUNTIME_STYLES.worktree.working : RUNTIME_STYLES.worktree.idle;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center rounded px-1 py-0.5 border transition-colors",
              styles,
              className
            )}
          >
            <WorktreeIcon />
          </span>
        </TooltipTrigger>
        <TooltipContent align="end">
          <div>Worktree: isolated git worktree</div>
          {branchName && <BranchWithLabel branchName={branchName} />}
          {workspacePath && <PathWithCopy path={workspacePath} />}
        </TooltipContent>
      </Tooltip>
    );
  }

  // Local project-dir runtime: show folder icon
  if (isLocalProjectRuntime(runtimeConfig)) {
    const styles = isWorking ? RUNTIME_STYLES.local.working : RUNTIME_STYLES.local.idle;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center rounded px-1 py-0.5 border transition-colors",
              styles,
              className
            )}
          >
            <LocalIcon />
          </span>
        </TooltipTrigger>
        <TooltipContent align="end">
          <div>Local: project directory</div>
          {branchName && <BranchWithLabel branchName={branchName} />}
          {workspacePath && <PathWithCopy path={workspacePath} />}
        </TooltipContent>
      </Tooltip>
    );
  }

  // Docker runtime: show container icon with image name
  if (isDockerRuntime(runtimeConfig)) {
    const styles = isWorking ? RUNTIME_STYLES.docker.working : RUNTIME_STYLES.docker.idle;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center rounded px-1 py-0.5 border transition-colors",
              styles,
              className
            )}
          >
            <DockerIcon />
          </span>
        </TooltipTrigger>
        <TooltipContent align="end">
          <div>Docker: {runtimeConfig.image}</div>
          {branchName && <BranchWithLabel branchName={branchName} />}
          {workspacePath && <PathWithCopy path={workspacePath} />}
        </TooltipContent>
      </Tooltip>
    );
  }

  return null;
}
