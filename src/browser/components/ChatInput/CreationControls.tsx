import React, { useCallback } from "react";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import { Select } from "../Select";
import { RuntimeIconSelector } from "../RuntimeIconSelector";
import { Loader2, Wand2 } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipWrapper } from "../Tooltip";
import type { WorkspaceNameState } from "@/browser/hooks/useWorkspaceName";

interface CreationControlsProps {
  branches: string[];
  trunkBranch: string;
  onTrunkBranchChange: (branch: string) => void;
  runtimeMode: RuntimeMode;
  defaultRuntimeMode: RuntimeMode;
  sshHost: string;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onSetDefaultRuntime: (mode: RuntimeMode) => void;
  onSshHostChange: (host: string) => void;
  disabled: boolean;
  /** Workspace name generation state and actions */
  nameState: WorkspaceNameState;
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

  const { nameState } = props;

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      nameState.setName(e.target.value);
    },
    [nameState]
  );

  // Clicking into the input disables auto-generation so user can edit
  const handleInputFocus = useCallback(() => {
    if (nameState.autoGenerate) {
      nameState.setAutoGenerate(false);
    }
  }, [nameState]);

  // Toggle auto-generation via wand button
  const handleWandClick = useCallback(() => {
    nameState.setAutoGenerate(!nameState.autoGenerate);
  }, [nameState]);

  return (
    <div className="flex flex-col gap-2">
      {/* First row: Workspace name with magic wand toggle */}
      <div className="flex items-center gap-2" data-component="WorkspaceNameGroup">
        <label htmlFor="workspace-name" className="text-muted text-xs whitespace-nowrap">
          Name:
        </label>
        <div className="relative max-w-xs flex-1">
          <input
            id="workspace-name"
            type="text"
            value={nameState.name}
            onChange={handleNameChange}
            onFocus={handleInputFocus}
            placeholder={nameState.isGenerating ? "Generating..." : "workspace-name"}
            disabled={props.disabled}
            className={cn(
              "bg-separator text-foreground border-border-medium focus:border-accent h-6 w-full rounded border px-2 pr-6 text-xs focus:outline-none disabled:opacity-50",
              nameState.error && "border-red-500"
            )}
          />
          {/* Magic wand / loading indicator - vertically centered */}
          <div className="absolute inset-y-0 right-0 flex items-center pr-1.5">
            {nameState.isGenerating ? (
              <Loader2 className="text-accent h-3.5 w-3.5 animate-spin" />
            ) : (
              <TooltipWrapper inline>
                <button
                  type="button"
                  onClick={handleWandClick}
                  disabled={props.disabled}
                  className="flex h-full items-center disabled:opacity-50"
                  aria-label={nameState.autoGenerate ? "Disable auto-naming" : "Enable auto-naming"}
                >
                  <Wand2
                    className={cn(
                      "h-3.5 w-3.5 transition-colors",
                      nameState.autoGenerate
                        ? "text-accent"
                        : "text-muted-foreground opacity-50 hover:opacity-75"
                    )}
                  />
                </button>
                <Tooltip className="tooltip" align="center">
                  {nameState.autoGenerate ? "Auto-naming enabled" : "Click to enable auto-naming"}
                </Tooltip>
              </TooltipWrapper>
            )}
          </div>
        </div>
        {/* Error display - inline */}
        {nameState.error && <span className="text-xs text-red-500">{nameState.error}</span>}
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
