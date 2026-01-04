import React from "react";
import { cn } from "@/common/lib/utils";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import { SSHIcon, WorktreeIcon, LocalIcon, DockerIcon } from "./icons/RuntimeIcons";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";

interface RuntimeIconSelectorProps {
  value: RuntimeMode;
  onChange: (mode: RuntimeMode) => void;
  /** The persisted default runtime for this project */
  defaultMode: RuntimeMode;
  /** Called when user checks "Default for project" in tooltip */
  onSetDefault: (mode: RuntimeMode) => void;
  disabled?: boolean;
  /** Modes that cannot be selected (e.g., worktree/SSH for non-git repos) */
  disabledModes?: RuntimeMode[];
  className?: string;
}

// Runtime-specific color schemes matching RuntimeBadge
// Colors use CSS variables (--color-runtime-*) so they adapt to theme (e.g., solarized)
// Selected (active) uses the "working" styling, unselected uses "idle"
const RUNTIME_STYLES = {
  ssh: {
    idle: "bg-transparent text-muted border-[var(--color-runtime-ssh)]/30 hover:border-[var(--color-runtime-ssh)]/50",
    active:
      "bg-[var(--color-runtime-ssh)]/20 text-[var(--color-runtime-ssh-text)] border-[var(--color-runtime-ssh)]/60",
  },
  worktree: {
    idle: "bg-transparent text-muted border-[var(--color-runtime-worktree)]/30 hover:border-[var(--color-runtime-worktree)]/50",
    active:
      "bg-[var(--color-runtime-worktree)]/20 text-[var(--color-runtime-worktree-text)] border-[var(--color-runtime-worktree)]/60",
  },
  local: {
    idle: "bg-transparent text-muted border-[var(--color-runtime-local)]/30 hover:border-[var(--color-runtime-local)]/50",
    active:
      "bg-[var(--color-runtime-local)]/30 text-foreground border-[var(--color-runtime-local)]/60",
  },
  docker: {
    idle: "bg-transparent text-muted border-[var(--color-runtime-docker)]/30 hover:border-[var(--color-runtime-docker)]/50",
    active:
      "bg-[var(--color-runtime-docker)]/20 text-[var(--color-runtime-docker-text)] border-[var(--color-runtime-docker)]/60",
  },
} as const;

const RUNTIME_INFO: Record<RuntimeMode, { label: string; description: string }> = {
  local: {
    label: "Local",
    description: "Work directly in project directory (no isolation)",
  },
  worktree: {
    label: "Worktree",
    description: "Git worktree in ~/.mux/src (isolated)",
  },
  ssh: {
    label: "SSH",
    description: "Remote clone on SSH host",
  },
  docker: {
    label: "Docker",
    description: "Isolated container per workspace",
  },
};

interface RuntimeIconButtonProps {
  mode: RuntimeMode;
  isSelected: boolean;
  isDefault: boolean;
  onClick: () => void;
  onSetDefault: () => void;
  disabled?: boolean;
  /** Why this mode is unavailable (shown in tooltip when disabled) */
  unavailableReason?: string;
}

function RuntimeIconButton(props: RuntimeIconButtonProps) {
  const info = RUNTIME_INFO[props.mode];
  const styles = RUNTIME_STYLES[props.mode];
  const stateStyle = props.isSelected ? styles.active : styles.idle;

  const Icon =
    props.mode === RUNTIME_MODE.SSH
      ? SSHIcon
      : props.mode === RUNTIME_MODE.WORKTREE
        ? WorktreeIcon
        : props.mode === RUNTIME_MODE.DOCKER
          ? DockerIcon
          : LocalIcon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={props.onClick}
          disabled={props.disabled}
          className={cn(
            "inline-flex items-center justify-center rounded border p-1 transition-colors",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500",
            stateStyle,
            props.disabled && "cursor-not-allowed opacity-50"
          )}
          aria-label={`${info.label} runtime`}
          aria-pressed={props.isSelected}
        >
          <Icon />
        </button>
      </TooltipTrigger>
      <TooltipContent
        align="center"
        side="bottom"
        className="pointer-events-auto max-w-80 whitespace-normal"
      >
        <strong>{info.label}</strong>
        <p className="text-muted mt-0.5 text-xs">{info.description}</p>
        {props.unavailableReason ? (
          <p className="mt-1 text-xs text-yellow-500">{props.unavailableReason}</p>
        ) : (
          <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={props.isDefault}
              onChange={() => props.onSetDefault()}
              className="accent-accent h-3 w-3"
            />
            <span className="text-muted">Default for project</span>
          </label>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Runtime selector using icons with tooltips.
 * Shows Local, Worktree, and SSH options as clickable icons.
 * Selected runtime uses "active" styling (brighter colors).
 * Each tooltip has a "Default for project" checkbox to persist the preference.
 */
export function RuntimeIconSelector(props: RuntimeIconSelectorProps) {
  const modes: RuntimeMode[] = [
    RUNTIME_MODE.LOCAL,
    RUNTIME_MODE.WORKTREE,
    RUNTIME_MODE.SSH,
    RUNTIME_MODE.DOCKER,
  ];
  const disabledModes = props.disabledModes ?? [];

  return (
    <div
      className={cn("inline-flex items-center gap-1", props.className)}
      data-component="RuntimeIconSelector"
      data-tutorial="runtime-selector"
    >
      {modes.map((mode) => {
        const isModeDisabled = disabledModes.includes(mode);
        return (
          <RuntimeIconButton
            key={mode}
            mode={mode}
            isSelected={props.value === mode}
            isDefault={props.defaultMode === mode}
            onClick={() => props.onChange(mode)}
            onSetDefault={() => props.onSetDefault(mode)}
            disabled={Boolean(props.disabled) || isModeDisabled}
            unavailableReason={isModeDisabled ? "Requires git repository" : undefined}
          />
        );
      })}
    </div>
  );
}
