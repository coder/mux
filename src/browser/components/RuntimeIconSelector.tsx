import React from "react";
import { cn } from "@/common/lib/utils";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import { SSHIcon, WorktreeIcon, LocalIcon } from "./icons/RuntimeIcons";
import { TooltipWrapper, Tooltip } from "./Tooltip";

interface RuntimeIconSelectorProps {
  value: RuntimeMode;
  onChange: (mode: RuntimeMode) => void;
  /** The persisted default runtime for this project */
  defaultMode: RuntimeMode;
  /** Called when user checks "Default for project" in tooltip */
  onSetDefault: (mode: RuntimeMode) => void;
  disabled?: boolean;
  className?: string;
}

// Runtime-specific color schemes matching RuntimeBadge
// Colors use CSS variables (--color-runtime-*) so they adapt to theme (e.g., solarized)
// Selected (active) uses the "working" styling, unselected uses "idle"
const RUNTIME_STYLES = {
  ssh: {
    idle: "bg-transparent text-muted border-[var(--color-runtime-ssh)]/30 hover:border-[var(--color-runtime-ssh)]/50",
    active:
      "bg-[var(--color-runtime-ssh)]/20 text-[var(--color-runtime-ssh)] border-[var(--color-runtime-ssh)]/60",
  },
  worktree: {
    idle: "bg-transparent text-muted border-[var(--color-runtime-worktree)]/30 hover:border-[var(--color-runtime-worktree)]/50",
    active:
      "bg-[var(--color-runtime-worktree)]/20 text-[var(--color-runtime-worktree)] border-[var(--color-runtime-worktree)]/60",
  },
  local: {
    idle: "bg-transparent text-muted border-[var(--color-runtime-local)]/30 hover:border-[var(--color-runtime-local)]/50",
    active:
      "bg-[var(--color-runtime-local)]/30 text-foreground border-[var(--color-runtime-local)]/60",
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
};

interface RuntimeIconButtonProps {
  mode: RuntimeMode;
  isSelected: boolean;
  isDefault: boolean;
  onClick: () => void;
  onSetDefault: () => void;
  disabled?: boolean;
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
        : LocalIcon;

  return (
    <TooltipWrapper inline>
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
      <Tooltip align="center" width="wide" position="bottom" interactive>
        <strong>{info.label}</strong>
        <p className="text-muted mt-0.5 text-xs">{info.description}</p>
        <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={props.isDefault}
            onChange={() => props.onSetDefault()}
            className="accent-accent h-3 w-3"
          />
          <span className="text-muted">Default for project</span>
        </label>
      </Tooltip>
    </TooltipWrapper>
  );
}

/**
 * Runtime selector using icons with tooltips.
 * Shows Local, Worktree, and SSH options as clickable icons.
 * Selected runtime uses "active" styling (brighter colors).
 * Each tooltip has a "Default for project" checkbox to persist the preference.
 */
export function RuntimeIconSelector(props: RuntimeIconSelectorProps) {
  const modes: RuntimeMode[] = [RUNTIME_MODE.LOCAL, RUNTIME_MODE.WORKTREE, RUNTIME_MODE.SSH];

  return (
    <div
      className={cn("inline-flex items-center gap-1", props.className)}
      data-component="RuntimeIconSelector"
      data-tutorial="runtime-selector"
    >
      {modes.map((mode) => (
        <RuntimeIconButton
          key={mode}
          mode={mode}
          isSelected={props.value === mode}
          isDefault={props.defaultMode === mode}
          onClick={() => props.onChange(mode)}
          onSetDefault={() => props.onSetDefault(mode)}
          disabled={props.disabled}
        />
      ))}
    </div>
  );
}
