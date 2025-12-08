import React from "react";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import { Select } from "../Select";

interface CreationControlsProps {
  branches: string[];
  trunkBranch: string;
  onTrunkBranchChange: (branch: string) => void;
  runtimeMode: RuntimeMode;
  sshHost: string;
  onSshHostChange: (host: string) => void;
  disabled: boolean;
}

/**
 * Additional controls shown only during workspace creation
 * - Trunk branch selector (which branch to fork from) - hidden for Local runtime
 * - SSH host input (only shown for SSH runtime)
 * Note: Runtime mode and workspace name are now in the header via CreationCenterContent
 */
export function CreationControls(props: CreationControlsProps) {
  // Local runtime doesn't need a trunk branch selector (uses project dir as-is)
  const showTrunkBranchSelector =
    props.branches.length > 0 && props.runtimeMode !== RUNTIME_MODE.LOCAL;

  // Don't render anything if there's nothing to show
  if (!showTrunkBranchSelector && props.runtimeMode !== RUNTIME_MODE.SSH) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
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
  );
}
