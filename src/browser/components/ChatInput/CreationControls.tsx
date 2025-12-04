import React, { useCallback } from "react";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import { Select } from "../Select";
import { RuntimeIconSelector } from "../RuntimeIconSelector";
import { Loader2 } from "lucide-react";
import { cn } from "@/common/lib/utils";

interface CreationControlsProps {
  branches: string[];
  trunkBranch: string;
  onTrunkBranchChange: (branch: string) => void;
  runtimeMode: RuntimeMode;
  defaultRuntimeMode: RuntimeMode;
  sshHost: string;
  /** Called when user clicks a runtime icon to select it (does not persist) */
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  /** Called when user checks "Default for project" checkbox (persists) */
  onSetDefaultRuntime: (mode: RuntimeMode) => void;
  /** Called when user changes SSH host */
  onSshHostChange: (host: string) => void;
  disabled: boolean;
  /** Workspace name state */
  workspaceName: string;
  /** Whether name is being generated */
  isGeneratingName: boolean;
  /** Whether auto-generation is enabled */
  autoGenerateName: boolean;
  /** Name generation error */
  nameError: string | null;
  /** Called when auto-generate checkbox changes */
  onAutoGenerateChange: (enabled: boolean) => void;
  /** Called when user types in the name field */
  onNameChange: (name: string) => void;
}

/**
 * Additional controls shown only during workspace creation
 * - Trunk branch selector (which branch to fork from) - hidden for Local runtime
 * - Runtime mode (Local, Worktree, SSH)
 * - Workspace name (auto-generated with manual override)
 */
export function CreationControls(props: CreationControlsProps) {
  // Local runtime doesn't need a trunk branch selector (uses project dir as-is)
  const showTrunkBranchSelector =
    props.branches.length > 0 && props.runtimeMode !== RUNTIME_MODE.LOCAL;

  const { onNameChange } = props;
  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onNameChange(e.target.value);
    },
    [onNameChange]
  );

  return (
    <div className="flex flex-col gap-2">
      {/* First row: Workspace name with auto-generate checkbox */}
      <div className="flex items-center gap-2" data-component="WorkspaceNameGroup">
        <label htmlFor="workspace-name" className="text-muted text-xs whitespace-nowrap">
          Name:
        </label>
        <div className="relative max-w-xs flex-1">
          <input
            id="workspace-name"
            type="text"
            value={props.workspaceName}
            onChange={handleNameChange}
            placeholder={props.isGeneratingName ? "Generating..." : "workspace-name"}
            disabled={props.disabled || props.autoGenerateName}
            className={cn(
              "bg-separator text-foreground border-border-medium focus:border-accent h-6 w-full rounded border px-2 pr-6 text-xs focus:outline-none disabled:opacity-50",
              props.nameError && "border-red-500"
            )}
          />
          {/* Loading indicator when generating */}
          {props.isGeneratingName && (
            <div className="absolute top-1/2 right-1 -translate-y-1/2">
              <Loader2 className="text-muted h-3 w-3 animate-spin" />
            </div>
          )}
        </div>
        {/* Auto-generate checkbox */}
        <label className="text-muted flex h-6 items-center gap-1 text-[10px] whitespace-nowrap">
          <input
            type="checkbox"
            checked={props.autoGenerateName}
            onChange={(e) => props.onAutoGenerateChange(e.target.checked)}
            disabled={props.disabled}
            className="h-3 w-3"
          />
          auto
        </label>
        {/* Error display - inline */}
        {props.nameError && <span className="text-xs text-red-500">{props.nameError}</span>}
      </div>

      {/* Second row: Runtime, Branch, SSH */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* Runtime Selector - icon-based with tooltips */}
        <RuntimeIconSelector
          value={props.runtimeMode}
          onChange={props.onRuntimeModeChange}
          defaultMode={props.defaultRuntimeMode}
          onSetDefault={props.onSetDefaultRuntime}
          disabled={props.disabled}
        />

        {/* Trunk Branch Selector - hidden for Local runtime */}
        {showTrunkBranchSelector && (
          <div
            className="flex h-6 items-center gap-1"
            data-component="TrunkBranchGroup"
            data-tutorial="trunk-branch"
          >
            <label htmlFor="trunk-branch" className="text-muted text-xs">
              From:
            </label>
            <Select
              id="trunk-branch"
              value={props.trunkBranch}
              options={props.branches}
              onChange={props.onTrunkBranchChange}
              disabled={props.disabled}
              className="h-6 max-w-[120px]"
            />
          </div>
        )}

        {/* SSH Host Input - after From selector */}
        {props.runtimeMode === RUNTIME_MODE.SSH && (
          <input
            type="text"
            value={props.sshHost}
            onChange={(e) => props.onSshHostChange(e.target.value)}
            placeholder="user@host"
            disabled={props.disabled}
            className="bg-separator text-foreground border-border-medium focus:border-accent h-6 w-32 rounded border px-1 text-xs focus:outline-none disabled:opacity-50"
          />
        )}
      </div>
    </div>
  );
}
