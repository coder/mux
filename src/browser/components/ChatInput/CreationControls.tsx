import React, { useEffect } from "react";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import { Select } from "../Select";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { SSHIcon, WorktreeIcon, LocalIcon } from "../icons/RuntimeIcons";

interface CreationControlsProps {
  branches: string[];
  /** Whether branches have finished loading (to distinguish loading vs non-git repo) */
  branchesLoaded: boolean;
  trunkBranch: string;
  onTrunkBranchChange: (branch: string) => void;
  runtimeMode: RuntimeMode;
  defaultRuntimeMode: RuntimeMode;
  sshHost: string;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onSetDefaultRuntime: (mode: RuntimeMode) => void;
  onSshHostChange: (host: string) => void;
  disabled: boolean;
  /** Project name to display as header */
  projectName: string;
}

/** Runtime type button group with icons and colors */
interface RuntimeButtonGroupProps {
  value: RuntimeMode;
  onChange: (mode: RuntimeMode) => void;
  disabled?: boolean;
  disabledModes?: RuntimeMode[];
}

const RUNTIME_OPTIONS: Array<{
  value: RuntimeMode;
  label: string;
  description: string;
  Icon: React.FC<{ size?: number; className?: string }>;
  // Active state colors using CSS variables for theme support
  activeClass: string;
  idleClass: string;
}> = [
  {
    value: RUNTIME_MODE.LOCAL,
    label: "Local",
    description: "Work directly in project directory",
    Icon: LocalIcon,
    activeClass:
      "bg-[var(--color-runtime-local)]/30 text-foreground border-[var(--color-runtime-local)]/60",
    idleClass:
      "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-local)]/40",
  },
  {
    value: RUNTIME_MODE.WORKTREE,
    label: "Worktree",
    description: "Isolated git worktree",
    Icon: WorktreeIcon,
    activeClass:
      "bg-[var(--color-runtime-worktree)]/20 text-[var(--color-runtime-worktree-text)] border-[var(--color-runtime-worktree)]/60",
    idleClass:
      "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-worktree)]/40",
  },
  {
    value: RUNTIME_MODE.SSH,
    label: "Remote",
    description: "Clone on SSH host",
    Icon: SSHIcon,
    activeClass:
      "bg-[var(--color-runtime-ssh)]/20 text-[var(--color-runtime-ssh-text)] border-[var(--color-runtime-ssh)]/60",
    idleClass:
      "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-ssh)]/40",
  },
];

function RuntimeButtonGroup(props: RuntimeButtonGroupProps) {
  const disabledModes = props.disabledModes ?? [];

  return (
    <div className="flex gap-1">
      {RUNTIME_OPTIONS.map((option) => {
        const isActive = props.value === option.value;
        const isModeDisabled = disabledModes.includes(option.value);
        const Icon = option.Icon;

        return (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => props.onChange(option.value)}
                disabled={Boolean(props.disabled) || isModeDisabled}
                aria-pressed={isActive}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all duration-150",
                  "cursor-pointer",
                  isActive ? option.activeClass : option.idleClass,
                  (Boolean(props.disabled) || isModeDisabled) && "cursor-not-allowed opacity-50"
                )}
              >
                <Icon size={12} />
                {option.label}
              </button>
            </TooltipTrigger>
            <TooltipContent align="center" side="bottom">
              {option.description}
              {isModeDisabled && <p className="mt-1 text-yellow-500">Requires git repository</p>}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * Prominent controls shown above the input during workspace creation.
 * Displays project name as header and runtime/branch selectors.
 */
export function CreationControls(props: CreationControlsProps) {
  // Non-git directories (empty branches after loading completes) can only use local runtime
  // Don't check until branches have loaded to avoid prematurely switching runtime
  const isNonGitRepo = props.branchesLoaded && props.branches.length === 0;

  // Local runtime doesn't need a trunk branch selector (uses project dir as-is)
  const showTrunkBranchSelector =
    props.branches.length > 0 && props.runtimeMode !== RUNTIME_MODE.LOCAL;

  const { runtimeMode, onRuntimeModeChange } = props;

  // Force local runtime for non-git directories (only after branches loaded)
  useEffect(() => {
    if (isNonGitRepo && runtimeMode !== RUNTIME_MODE.LOCAL) {
      onRuntimeModeChange(RUNTIME_MODE.LOCAL);
    }
  }, [isNonGitRepo, runtimeMode, onRuntimeModeChange]);

  return (
    <div className="mb-3 flex flex-col gap-4">
      {/* Project name header */}
      <h2 className="text-foreground text-lg font-semibold">{props.projectName}</h2>

      {/* Runtime type - button group */}
      <div className="flex flex-col gap-1.5" data-component="RuntimeTypeGroup">
        <label className="text-muted-foreground text-xs font-medium">Workspace Type</label>
        <div className="flex flex-wrap items-center gap-3">
          <RuntimeButtonGroup
            value={props.runtimeMode}
            onChange={props.onRuntimeModeChange}
            disabled={props.disabled}
            disabledModes={isNonGitRepo ? [RUNTIME_MODE.WORKTREE, RUNTIME_MODE.SSH] : undefined}
          />

          {/* Branch selector - shown for worktree/SSH */}
          {showTrunkBranchSelector && (
            <div
              className="flex items-center gap-2"
              data-component="TrunkBranchGroup"
              data-tutorial="trunk-branch"
            >
              <label htmlFor="trunk-branch" className="text-muted-foreground text-xs">
                from
              </label>
              <Select
                id="trunk-branch"
                value={props.trunkBranch}
                options={props.branches}
                onChange={props.onTrunkBranchChange}
                disabled={props.disabled}
                className="h-7 max-w-[140px]"
              />
            </div>
          )}

          {/* SSH Host Input */}
          {props.runtimeMode === RUNTIME_MODE.SSH && (
            <div className="flex items-center gap-2">
              <label className="text-muted-foreground text-xs">host</label>
              <input
                type="text"
                value={props.sshHost}
                onChange={(e) => props.onSshHostChange(e.target.value)}
                placeholder="user@host"
                disabled={props.disabled}
                className="bg-bg-dark text-foreground border-border-medium focus:border-accent h-7 w-36 rounded-md border px-2 text-sm focus:outline-none disabled:opacity-50"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
