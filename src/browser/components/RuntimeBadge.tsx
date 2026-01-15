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
  /** Workspace name to show in tooltip */
  workspaceName?: string;
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

function WorkspaceNameLabel({ workspaceName }: { workspaceName: string }) {
  return (
    <div className="mt-1 flex max-w-80 items-baseline gap-1">
      <span className="text-muted shrink-0">Workspace:</span>
      <span className="min-w-0 font-mono break-words">{workspaceName}</span>
    </div>
  );
}

type RuntimeType = keyof typeof RUNTIME_STYLES;

const RUNTIME_ICONS: Record<RuntimeType, React.ComponentType> = {
  ssh: SSHIcon,
  worktree: WorktreeIcon,
  local: LocalIcon,
  docker: DockerIcon,
};

function getRuntimeInfo(
  runtimeConfig?: RuntimeConfig
): { type: RuntimeType; label: string } | null {
  if (isSSHRuntime(runtimeConfig)) {
    const hostname = extractSshHostname(runtimeConfig);
    return { type: "ssh", label: `SSH: ${hostname ?? runtimeConfig.host}` };
  }
  if (isWorktreeRuntime(runtimeConfig)) {
    return { type: "worktree", label: "Worktree: isolated git worktree" };
  }
  if (isLocalProjectRuntime(runtimeConfig)) {
    return { type: "local", label: "Local: project directory" };
  }
  if (isDockerRuntime(runtimeConfig)) {
    return { type: "docker", label: `Docker: ${runtimeConfig.image}` };
  }
  return null;
}

export function RuntimeBadge({
  runtimeConfig,
  className,
  isWorking = false,
  workspacePath,
  workspaceName,
}: RuntimeBadgeProps) {
  const info = getRuntimeInfo(runtimeConfig);
  if (!info) return null;

  const styles = isWorking ? RUNTIME_STYLES[info.type].working : RUNTIME_STYLES[info.type].idle;
  const Icon = RUNTIME_ICONS[info.type];

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
          <Icon />
        </span>
      </TooltipTrigger>
      <TooltipContent align="end">
        <div>{info.label}</div>
        {workspaceName && <WorkspaceNameLabel workspaceName={workspaceName} />}
        {workspacePath && <PathWithCopy path={workspacePath} />}
      </TooltipContent>
    </Tooltip>
  );
}
