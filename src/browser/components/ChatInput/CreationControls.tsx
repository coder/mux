import React, { useCallback } from "react";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import { Select } from "../Select";
import { RuntimeIconSelector } from "../RuntimeIconSelector";
import { Loader2, Wand2 } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipWrapper } from "../Tooltip";

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

  const { onNameChange, onAutoGenerateChange } = props;

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onNameChange(e.target.value);
    },
    [onNameChange]
  );

  // Clicking into the input disables auto-generation so user can edit
  const handleInputFocus = useCallback(() => {
    if (props.autoGenerateName) {
      onAutoGenerateChange(false);
    }
  }, [props.autoGenerateName, onAutoGenerateChange]);

  // Toggle auto-generation via wand button
  const handleWandClick = useCallback(() => {
    onAutoGenerateChange(!props.autoGenerateName);
  }, [props.autoGenerateName, onAutoGenerateChange]);

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
            value={props.workspaceName}
            onChange={handleNameChange}
            onFocus={handleInputFocus}
            placeholder={props.isGeneratingName ? "Generating..." : "workspace-name"}
            disabled={props.disabled}
            className={cn(
              "bg-separator text-foreground border-border-medium focus:border-accent h-6 w-full rounded border px-2 pr-6 text-xs focus:outline-none disabled:opacity-50",
              props.nameError && "border-red-500"
            )}
          />
          {/* Magic wand / loading indicator */}
          <div className="absolute top-1/2 right-1.5 -translate-y-1/2">
            {props.isGeneratingName ? (
              <Loader2 className="text-accent h-3.5 w-3.5 animate-spin" />
            ) : (
              <TooltipWrapper inline>
                <button
                  type="button"
                  onClick={handleWandClick}
                  disabled={props.disabled}
                  className="flex items-center justify-center disabled:opacity-50"
                  aria-label={props.autoGenerateName ? "Disable auto-naming" : "Enable auto-naming"}
                >
                  <Wand2
                    className={cn(
                      "h-3.5 w-3.5 transition-colors",
                      props.autoGenerateName
                        ? "text-accent"
                        : "text-muted-foreground opacity-50 hover:opacity-75"
                    )}
                  />
                </button>
                <Tooltip className="tooltip" align="center">
                  {props.autoGenerateName ? "Auto-naming enabled" : "Click to enable auto-naming"}
                </Tooltip>
              </TooltipWrapper>
            )}
          </div>
        </div>
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
