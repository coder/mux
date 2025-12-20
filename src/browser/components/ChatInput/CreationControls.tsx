import React, { useCallback, useEffect } from "react";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import { BranchNameInput } from "../BranchNameInput";
import { Select } from "../Select";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { SSHIcon, WorktreeIcon, LocalIcon } from "../icons/RuntimeIcons";
import { DocsLink } from "../DocsLink";
import type { ExistingBranchSelection } from "@/common/types/branchSelection";
import type { BranchListResult } from "@/common/orpc/types";
import type { WorkspaceNameState } from "@/browser/hooks/useWorkspaceName";

export type BranchMode = "new" | "existing";

interface CreationControlsProps {
  branches: string[];
  /** Remote-only branches (not in local branches) */
  remoteBranches: string[];
  /** Remote-only branches grouped by remote name (e.g. origin/upstream) */
  remoteBranchGroups: BranchListResult["remoteBranchGroups"];
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
  /** Workspace name/title generation state and actions */
  nameState: WorkspaceNameState;
  /** Branch mode: "new" creates a new branch, "existing" uses an existing branch */
  branchMode: BranchMode;
  onBranchModeChange: (mode: BranchMode) => void;
  /** Selected existing branch (when branchMode is "existing") */
  selectedExistingBranch: ExistingBranchSelection | null;
  onSelectedExistingBranchChange: (selection: ExistingBranchSelection | null) => void;
}

/** Runtime type button group with icons and colors */
interface RuntimeButtonGroupProps {
  value: RuntimeMode;
  onChange: (mode: RuntimeMode) => void;
  defaultMode: RuntimeMode;
  onSetDefault: (mode: RuntimeMode) => void;
  disabled?: boolean;
  disabledModes?: RuntimeMode[];
}

const RUNTIME_OPTIONS: Array<{
  value: RuntimeMode;
  label: string;
  description: string;
  docsPath: string;
  Icon: React.FC<{ size?: number; className?: string }>;
  // Active state colors using CSS variables for theme support
  activeClass: string;
  idleClass: string;
}> = [
  {
    value: RUNTIME_MODE.LOCAL,
    label: "Local",
    description: "Work directly in project directory",
    docsPath: "/runtime/local",
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
    docsPath: "/runtime/worktree",
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
    docsPath: "/runtime/ssh",
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
        const isDefault = props.defaultMode === option.value;
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
            <TooltipContent
              align="center"
              side="bottom"
              className="pointer-events-auto whitespace-normal"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span>{option.description}</span>
                <DocsLink path={option.docsPath} />
              </div>
              {isModeDisabled ? (
                <p className="mt-1 text-yellow-500">Requires git repository</p>
              ) : (
                <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={isDefault}
                    onChange={() => props.onSetDefault(option.value)}
                    className="accent-accent h-3 w-3"
                  />
                  <span className="text-muted">Default for project</span>
                </label>
              )}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * Prominent controls shown above the input during workspace creation.
 * Displays project name as header, unified branch name input, and runtime/branch selectors.
 *
 * The branch name input is a combobox that:
 * - Shows matching existing branches as user types
 * - Selecting a branch → uses existing branch, hides "from main"
 * - Typing a non-matching name → creates new branch with that name
 * - Auto-generation via magic wand when input is empty
 */
export function CreationControls(props: CreationControlsProps) {
  const { nameState } = props;

  // Non-git directories (empty branches after loading completes) can only use local runtime
  // Don't check until branches have loaded to avoid prematurely switching runtime
  const isNonGitRepo = props.branchesLoaded && props.branches.length === 0;

  // Local runtime doesn't need a trunk branch selector (uses project dir as-is)
  // Also hide it when using an existing branch (no need to specify "from main")
  const showTrunkBranchSelector =
    props.branches.length > 0 &&
    props.runtimeMode !== RUNTIME_MODE.LOCAL &&
    props.selectedExistingBranch === null;

  const { runtimeMode, onRuntimeModeChange } = props;

  // Force local runtime for non-git directories (only after branches loaded)
  useEffect(() => {
    if (isNonGitRepo && runtimeMode !== RUNTIME_MODE.LOCAL) {
      onRuntimeModeChange(RUNTIME_MODE.LOCAL);
    }
  }, [isNonGitRepo, runtimeMode, onRuntimeModeChange]);

  const remoteGroups =
    props.remoteBranchGroups.length > 0
      ? props.remoteBranchGroups
      : props.remoteBranches.length > 0
        ? [{ remote: "origin", branches: props.remoteBranches, truncated: false }]
        : [];

  // Handle selecting an existing branch
  const handleSelectExistingBranch = useCallback(
    (selection: ExistingBranchSelection | null) => {
      props.onSelectedExistingBranchChange(selection);
      // Update branch mode based on selection
      props.onBranchModeChange(selection ? "existing" : "new");
    },
    [props]
  );

  return (
    <div className="mb-3 flex flex-col gap-4">
      {/* Project name / workspace name header row */}
      <div className="flex items-center" data-component="WorkspaceNameGroup">
        <h2 className="text-foreground shrink-0 text-lg font-semibold">{props.projectName}</h2>
        <span className="text-muted-foreground mx-2 text-lg">/</span>

        {/* Unified branch name input with autocomplete */}
        <BranchNameInput
          value={nameState.name}
          onChange={nameState.setName}
          autoGenerate={nameState.autoGenerate}
          onAutoGenerateChange={nameState.setAutoGenerate}
          isGenerating={nameState.isGenerating}
          error={nameState.error}
          localBranches={props.branches}
          remoteBranchGroups={remoteGroups}
          branchesLoaded={props.branchesLoaded}
          selectedExistingBranch={props.selectedExistingBranch}
          onSelectExistingBranch={handleSelectExistingBranch}
          disabled={props.disabled}
        />

        {/* Show remote indicator when existing remote branch is selected */}
        {props.selectedExistingBranch?.kind === "remote" && (
          <span className="text-muted-foreground ml-1 text-xs">
            @{props.selectedExistingBranch.remote}
          </span>
        )}

        {/* Error display */}
        {nameState.error && <span className="ml-2 text-xs text-red-500">{nameState.error}</span>}
      </div>

      {/* Runtime type - button group */}
      <div className="flex flex-col gap-1.5" data-component="RuntimeTypeGroup">
        <label className="text-muted-foreground text-xs font-medium">Workspace Type</label>
        <div className="flex flex-wrap items-center gap-3">
          <RuntimeButtonGroup
            value={props.runtimeMode}
            onChange={props.onRuntimeModeChange}
            defaultMode={props.defaultRuntimeMode}
            onSetDefault={props.onSetDefaultRuntime}
            disabled={props.disabled}
            disabledModes={isNonGitRepo ? [RUNTIME_MODE.WORKTREE, RUNTIME_MODE.SSH] : undefined}
          />

          {/* Branch selector - shown for worktree/SSH when creating new branch */}
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
