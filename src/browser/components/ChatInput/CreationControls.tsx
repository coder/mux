import React from "react";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import { TooltipWrapper, Tooltip } from "../Tooltip";
import { Select } from "../Select";

interface CreationControlsProps {
  branches: string[];
  trunkBranch: string;
  onTrunkBranchChange: (branch: string) => void;
  runtimeMode: RuntimeMode;
  sshHost: string;
  onRuntimeChange: (mode: RuntimeMode, host: string) => void;
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
      {/* Runtime Selector - first */}
      <div
        className="flex items-center gap-1"
        data-component="RuntimeSelectorGroup"
        data-tutorial="runtime-selector"
      >
        <label className="text-muted text-xs">Runtime:</label>
        <Select
          value={props.runtimeMode}
          options={[
            { value: RUNTIME_MODE.LOCAL, label: "Local" },
            { value: RUNTIME_MODE.WORKTREE, label: "Worktree" },
            { value: RUNTIME_MODE.SSH, label: "SSH" },
          ]}
          onChange={(newMode) => {
            const mode = newMode as RuntimeMode;
            // Clear SSH host when switching away from SSH
            props.onRuntimeChange(mode, mode === RUNTIME_MODE.SSH ? props.sshHost : "");
          }}
          disabled={props.disabled}
          aria-label="Runtime mode"
        />
        <TooltipWrapper inline>
          <span className="text-muted cursor-help text-xs">?</span>
          <Tooltip className="tooltip" align="center" width="wide">
            <strong>Runtime:</strong>
            <br />
            • Local: work directly in project directory (no isolation)
            <br />
            • Worktree: git worktree in ~/.mux/src (isolated)
            <br />• SSH: remote clone on SSH host
          </Tooltip>
        </TooltipWrapper>
      </div>

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
          onChange={(e) => props.onRuntimeChange(RUNTIME_MODE.SSH, e.target.value)}
          placeholder="user@host"
          disabled={props.disabled}
          className="bg-separator text-foreground border-border-medium focus:border-accent w-32 rounded border px-1 py-0.5 text-xs focus:outline-none disabled:opacity-50"
        />
      )}
    </div>
  );
}
