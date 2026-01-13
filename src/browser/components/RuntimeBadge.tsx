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
import { SSHIcon, WorktreeIcon, LocalIcon, DockerIcon, CoderIcon } from "./icons/RuntimeIcons";
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
  /** Tooltip position: "top" (default) or "bottom" */
  tooltipSide?: "top" | "bottom";
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
  coder: {
    // Coder uses SSH styling since it's an SSH-based runtime
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
function TooltipRow({
  label,
  value,
  copyable,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  const { copied, copyToClipboard } = useCopyToClipboard();

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted shrink-0 text-xs">{label}</span>
      <span className="font-mono text-xs whitespace-nowrap">{value}</span>
      {copyable && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            void copyToClipboard(value);
          }}
          className="text-muted hover:text-foreground shrink-0"
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      )}
    </div>
  );
}

type RuntimeType = keyof typeof RUNTIME_STYLES;

const RUNTIME_ICONS: Record<RuntimeType, React.ComponentType> = {
  ssh: SSHIcon,
  coder: CoderIcon,
  worktree: WorktreeIcon,
  local: LocalIcon,
  docker: DockerIcon,
};

function getRuntimeInfo(
  runtimeConfig?: RuntimeConfig
): { type: RuntimeType; label: string } | null {
  if (isSSHRuntime(runtimeConfig)) {
    // Coder-backed SSH runtime gets special treatment
    if (runtimeConfig.coder) {
      const coderWorkspaceName = runtimeConfig.coder.workspaceName;
      return { type: "coder", label: `Coder: ${coderWorkspaceName ?? runtimeConfig.host}` };
    }
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
  tooltipSide = "top",
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
      <TooltipContent side={tooltipSide} align="start" className="max-w-[500px]">
        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium">{info.label}</div>
          {workspaceName && <TooltipRow label="Name" value={workspaceName} />}
          {workspacePath && <TooltipRow label="Path" value={workspacePath} copyable />}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
