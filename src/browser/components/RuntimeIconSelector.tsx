import React from "react";
import { cn } from "@/common/lib/utils";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import { SSHIcon, WorktreeIcon, LocalIcon } from "./icons/RuntimeIcons";
import { TooltipWrapper, Tooltip } from "./Tooltip";

interface RuntimeIconSelectorProps {
  value: RuntimeMode;
  onChange: (mode: RuntimeMode) => void;
  disabled?: boolean;
  className?: string;
}

// Runtime-specific color schemes matching RuntimeBadge
// Selected (active) uses the "working" styling, unselected uses "idle"
const RUNTIME_STYLES = {
  ssh: {
    idle: "bg-transparent text-muted border-blue-500/30 hover:border-blue-500/50",
    active: "bg-blue-500/20 text-blue-400 border-blue-500/60",
  },
  worktree: {
    idle: "bg-transparent text-muted border-purple-500/30 hover:border-purple-500/50",
    active: "bg-purple-500/20 text-purple-400 border-purple-500/60",
  },
  local: {
    idle: "bg-transparent text-muted border-muted/30 hover:border-muted/50",
    active: "bg-muted/30 text-foreground border-muted/60",
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
  onClick: () => void;
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
          "inline-flex items-center justify-center rounded border p-1.5 transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500",
          stateStyle,
          props.disabled && "cursor-not-allowed opacity-50"
        )}
        aria-label={`${info.label} runtime`}
        aria-pressed={props.isSelected}
      >
        <Icon size={14} />
      </button>
      <Tooltip align="center" width="wide" position="bottom">
        <strong>{info.label}</strong>
        <p className="text-muted mt-0.5">{info.description}</p>
      </Tooltip>
    </TooltipWrapper>
  );
}

/**
 * Runtime selector using icons with tooltips.
 * Shows Local, Worktree, and SSH options as clickable icons.
 * Selected runtime uses "active" styling (brighter colors).
 * Clicking an icon sets it as the project default.
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
          onClick={() => props.onChange(mode)}
          disabled={props.disabled}
        />
      ))}
    </div>
  );
}
