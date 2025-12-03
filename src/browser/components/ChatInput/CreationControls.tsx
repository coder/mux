import React from "react";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import { Select } from "../Select";
import { RuntimeIconSelector } from "../RuntimeIconSelector";

interface CreationControlsProps {
  branches: string[];
  trunkBranch: string;
  onTrunkBranchChange: (branch: string) => void;
  runtimeMode: RuntimeMode;
  sshHost: string;
  /** Called when user changes runtime mode via checkbox in tooltip */
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  /** Called when user changes SSH host */
  onSshHostChange: (host: string) => void;
  disabled: boolean;
}

/**
 * Additional controls shown only during workspace creation
 * - Trunk branch selector (which branch to fork from) - hidden for Local runtime
 * - Runtime mode (Local, Worktree, SSH)
 */
export function CreationControls(props: CreationControlsProps) {
  // Local runtime doesn't need a trunk branch selector (uses project dir as-is)
  const showTrunkBranchSelector =
    props.branches.length > 0 && props.runtimeMode !== RUNTIME_MODE.LOCAL;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {/* Runtime Selector - icon-based with tooltips */}
      <RuntimeIconSelector
        value={props.runtimeMode}
        onChange={props.onRuntimeModeChange}
        disabled={props.disabled}
      />

      {/* Trunk Branch Selector - hidden for Local runtime */}
      {showTrunkBranchSelector && (
        <div
          className="flex items-center gap-1"
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
            className="max-w-[120px]"
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
          className="bg-separator text-foreground border-border-medium focus:border-accent w-32 rounded border px-1 py-0.5 text-xs focus:outline-none disabled:opacity-50"
        />
      )}
    </div>
  );
}
