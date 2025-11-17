import React from "react";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import { TooltipWrapper, Tooltip } from "../Tooltip";
import { Select } from "../Select";

interface CreationControlsProps {
  branches: string[];
  trunkBranch: string;
  onTrunkBranchChange: (branch: string) => void;
  fetchLatest: boolean;
  onFetchLatestChange: (value: boolean) => void;
  runtimeMode: RuntimeMode;
  sshHost: string;
  onRuntimeChange: (mode: RuntimeMode, host: string) => void;
  disabled: boolean;
}

/**
 * Additional controls shown only during workspace creation
 * - Trunk branch selector (which branch to fork from)
 * - Runtime mode (local vs SSH)
 */
export function CreationControls(props: CreationControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {/* Trunk Branch Selector */}
      {props.branches.length > 0 && (
        <div className="flex items-center gap-1" data-component="TrunkBranchGroup">
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

      {/* Runtime Selector */}
      <div className="flex items-center gap-1" data-component="RuntimeSelectorGroup">
        <label className="text-muted text-xs">Runtime:</label>
        <Select
          value={props.runtimeMode}
          options={[
            { value: RUNTIME_MODE.LOCAL, label: "Local" },
            { value: RUNTIME_MODE.SSH, label: "SSH" },
          ]}
          onChange={(newMode) => {
            const mode = newMode as RuntimeMode;
            props.onRuntimeChange(mode, mode === RUNTIME_MODE.LOCAL ? "" : props.sshHost);
          }}
          disabled={props.disabled}
          aria-label="Runtime mode"
        />
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
        <TooltipWrapper inline>
          <span className="text-muted cursor-help text-xs">?</span>
          <Tooltip className="tooltip" align="center" width="wide">
            <strong>Runtime:</strong>
            <br />
            • Local: git worktree in ~/.mux/src
            <br />• SSH: remote clone in ~/mux on SSH host
          </Tooltip>
        </TooltipWrapper>
      </div>

      {/* Fetch latest option */}
      <div className="flex items-center gap-1" data-component="FetchLatestGroup">
        <label className="flex items-center gap-1 text-xs text-muted" htmlFor="fetch-latest">
          <input
            id="fetch-latest"
            type="checkbox"
            className="accent-accent h-3.5 w-3.5"
            checked={props.fetchLatest}
            onChange={(event) => props.onFetchLatestChange(event.target.checked)}
            disabled={props.disabled}
          />
          Fetch latest
        </label>
        <TooltipWrapper inline>
          <span className="text-muted cursor-help text-xs">?</span>
          <Tooltip className="tooltip" align="center" width="wide">
            <strong>Fetch latest:</strong>
            <br />
            Runs <code>git fetch origin --prune</code> before branching so new workspaces start from
            the freshest remote state.
          </Tooltip>
        </TooltipWrapper>
      </div>
    </div>
  );
}
