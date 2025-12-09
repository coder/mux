import React, { useCallback } from "react";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "../ui/select";
import { Loader2, Wand2 } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import type { WorkspaceNameState } from "@/browser/hooks/useWorkspaceName";
import { Select as SimpleSelect } from "../Select";

// Runtime-specific text colors matching RuntimeIconSelector
const RUNTIME_TEXT_COLORS: Record<RuntimeMode, string> = {
  [RUNTIME_MODE.SSH]: "text-[var(--color-runtime-ssh-text)]",
  [RUNTIME_MODE.WORKTREE]: "text-[var(--color-runtime-worktree-text)]",
  [RUNTIME_MODE.LOCAL]: "text-[var(--color-runtime-local-text,var(--color-foreground))]",
};

interface CreationCenterContentProps {
  projectName: string;
  isSending: boolean;
  /** The confirmed workspace name (null while name generation is in progress) */
  workspaceName?: string | null;
  /** Current runtime mode */
  runtimeMode: RuntimeMode;
  /** Callback when runtime mode changes */
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  /** Whether controls are disabled */
  disabled?: boolean;
  /** Content to render in the main area (textarea, etc.) */
  children?: React.ReactNode;
  /** Workspace name generation state and actions */
  nameState: WorkspaceNameState;
  /** Available branches for trunk branch selector */
  branches: string[];
  /** Current trunk branch */
  trunkBranch: string;
  /** Callback when trunk branch changes */
  onTrunkBranchChange: (branch: string) => void;
  /** SSH host input value */
  sshHost: string;
  /** Callback when SSH host changes */
  onSshHostChange: (host: string) => void;
}

/**
 * Header for the creation view showing "New Chat in [Runtime Mode] - [workspace-name]"
 * Runtime mode is selectable via dropdown, workspace name is editable inline
 * From/Host controls are shown below the header
 */
export function CreationCenterContent(props: CreationCenterContentProps) {
  const { nameState } = props;
  const runtimeColor = RUNTIME_TEXT_COLORS[props.runtimeMode];

  // Local runtime doesn't need a trunk branch selector (uses project dir as-is)
  const showTrunkBranchSelector =
    props.branches.length > 0 && props.runtimeMode !== RUNTIME_MODE.LOCAL;

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

  if (props.isSending) {
    // Show loading overlay when creating workspace
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-xl px-8 text-center">
          <div className="bg-accent mb-4 inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <h2 className="text-foreground mb-2 text-lg font-medium">Creating workspace</h2>
          <p className="text-muted text-sm leading-relaxed">
            {props.workspaceName ? (
              <code className="bg-separator rounded px-1">{props.workspaceName}</code>
            ) : (
              "Generating name…"
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden p-6">
      {/* Header: New Chat in [Runtime Mode dropdown] - [workspace-name] */}
      <div className="mb-2 flex items-center gap-2">
        <h1 className="text-foreground text-xl font-semibold">New Chat in</h1>
        <Select
          value={props.runtimeMode}
          onValueChange={(value) => props.onRuntimeModeChange(value as RuntimeMode)}
          disabled={props.disabled}
        >
          <SelectTrigger
            className={cn(
              "h-auto w-auto gap-1 border-0 bg-transparent p-0 text-xl font-semibold transition-opacity hover:opacity-80 focus:ring-0 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:opacity-100",
              runtimeColor
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              value={RUNTIME_MODE.WORKTREE}
              className="text-[var(--color-runtime-worktree-text)]"
            >
              Git Worktree
            </SelectItem>
            <SelectItem value={RUNTIME_MODE.SSH} className="text-[var(--color-runtime-ssh-text)]">
              SSH
            </SelectItem>
            <SelectItem value={RUNTIME_MODE.LOCAL}>Local</SelectItem>
          </SelectContent>
        </Select>

        {/* Separator and workspace name */}
        <span className="text-muted text-xl">—</span>
        <div className="relative flex items-center">
          <input
            type="text"
            value={nameState.name}
            onChange={handleNameChange}
            onFocus={handleInputFocus}
            placeholder={nameState.isGenerating ? "generating..." : "workspace-name"}
            disabled={props.disabled}
            className={cn(
              "text-foreground h-auto border-0 border-b border-transparent bg-transparent p-0 pr-6 text-xl font-semibold focus:border-b-border-light focus:outline-none disabled:opacity-50",
              nameState.error && "border-b-red-500"
            )}
            style={{ width: `${Math.max(nameState.name.length, 24)}ch` }}
          />
          {/* Magic wand / loading indicator */}
          <div className="absolute right-0 flex items-center">
            {nameState.isGenerating ? (
              <Loader2 className="text-accent h-4 w-4 animate-spin" />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleWandClick}
                    disabled={props.disabled}
                    className="flex items-center disabled:opacity-50"
                    aria-label={
                      nameState.autoGenerate ? "Disable auto-naming" : "Enable auto-naming"
                    }
                  >
                    <Wand2
                      className={cn(
                        "h-4 w-4 transition-colors",
                        nameState.autoGenerate
                          ? "text-accent"
                          : "text-muted-foreground opacity-50 hover:opacity-75"
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent align="center">
                  {nameState.autoGenerate ? "Auto-naming enabled" : "Click to enable auto-naming"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        {nameState.error && <span className="text-sm text-red-500">{nameState.error}</span>}
      </div>

      {/* From/Host controls - below header */}
      {(showTrunkBranchSelector || props.runtimeMode === RUNTIME_MODE.SSH) && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
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
              <SimpleSelect
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
      )}

      {/* Main content area - prompt text, with override to allow textarea to grow */}
      <div className="min-h-0 flex-1 overflow-y-auto [&_textarea]:max-h-none [&_textarea]:min-h-[200px] [&_textarea]:flex-1">
        {props.children}
      </div>
    </div>
  );
}
