import { useRename } from "@/browser/contexts/WorkspaceRenameContext";
import { cn } from "@/common/lib/utils";
import { useGitStatus } from "@/browser/stores/GitStatusStore";
import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import React, { useState } from "react";
import { GitStatusIndicator } from "./GitStatusIndicator";
import { RuntimeBadge } from "./RuntimeBadge";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { WorkspaceStatusIndicator } from "./WorkspaceStatusIndicator";
import { Shimmer } from "./ai-elements/shimmer";

export interface WorkspaceSelection {
  projectPath: string;
  projectName: string;
  namedWorkspacePath: string; // Worktree path (directory uses workspace name)
  workspaceId: string;
}
export interface WorkspaceListItemProps {
  // Workspace metadata passed directly
  metadata: FrontendWorkspaceMetadata;
  projectPath: string;
  projectName: string;
  isSelected: boolean;
  isDeleting?: boolean;
  /** @deprecated No longer used since status dot was removed, kept for API compatibility */
  lastReadTimestamp?: number;
  // Event handlers
  onSelectWorkspace: (selection: WorkspaceSelection) => void;
  onRemoveWorkspace: (workspaceId: string, button: HTMLElement) => Promise<void>;
  /** @deprecated No longer used since status dot was removed, kept for API compatibility */
  onToggleUnread?: (workspaceId: string) => void;
}

const WorkspaceListItemInner: React.FC<WorkspaceListItemProps> = ({
  metadata,
  projectPath,
  projectName,
  isSelected,
  isDeleting,
  lastReadTimestamp: _lastReadTimestamp,
  onSelectWorkspace,
  onRemoveWorkspace,
  onToggleUnread: _onToggleUnread,
}) => {
  // Destructure metadata for convenience
  const { id: workspaceId, name: workspaceName, namedWorkspacePath, status } = metadata;
  const isCreating = status === "creating";
  const isDisabled = isCreating || isDeleting;
  const gitStatus = useGitStatus(workspaceId);

  // Get rename context
  const { editingWorkspaceId, requestRename, confirmRename, cancelRename } = useRename();

  // Local state for rename
  const [editingName, setEditingName] = useState<string>("");
  const [renameError, setRenameError] = useState<string | null>(null);

  const displayName = workspaceName;
  const isEditing = editingWorkspaceId === workspaceId;

  const startRenaming = () => {
    if (requestRename(workspaceId, displayName)) {
      setEditingName(displayName);
      setRenameError(null);
    }
  };

  const handleConfirmRename = async () => {
    if (!editingName.trim()) {
      setRenameError("Name cannot be empty");
      return;
    }

    const result = await confirmRename(workspaceId, editingName);
    if (!result.success) {
      setRenameError(result.error ?? "Failed to rename workspace");
    } else {
      setRenameError(null);
    }
  };

  const handleCancelRename = () => {
    cancelRename();
    setEditingName("");
    setRenameError(null);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleConfirmRename();
    } else if (e.key === "Escape") {
      // Stop propagation to prevent global Escape handler from interrupting stream
      e.preventDefault();
      e.stopPropagation();
      handleCancelRename();
    }
  };

  const { canInterrupt } = useWorkspaceSidebarState(workspaceId);

  return (
    <React.Fragment>
      <div
        className={cn(
          "py-1.5 pl-[9px] pr-2 border-l-[3px] border-transparent transition-all duration-150 text-[13px] relative flex gap-2",
          isDisabled
            ? "cursor-default opacity-70"
            : "cursor-pointer hover:bg-hover [&:hover_button]:opacity-100",
          isSelected && !isDisabled && "bg-hover border-l-blue-400",
          isDeleting && "pointer-events-none"
        )}
        onClick={() => {
          if (isDisabled) return;
          onSelectWorkspace({
            projectPath,
            projectName,
            namedWorkspacePath,
            workspaceId,
          });
        }}
        onKeyDown={(e) => {
          if (isDisabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelectWorkspace({
              projectPath,
              projectName,
              namedWorkspacePath,
              workspaceId,
            });
          }
        }}
        role="button"
        tabIndex={isDisabled ? -1 : 0}
        aria-current={isSelected ? "true" : undefined}
        aria-label={
          isCreating
            ? `Creating workspace ${displayName}`
            : isDeleting
              ? `Deleting workspace ${displayName}`
              : `Select workspace ${displayName}`
        }
        aria-disabled={isDisabled}
        data-workspace-path={namedWorkspacePath}
        data-workspace-id={workspaceId}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="grid min-w-0 grid-cols-[auto_auto_1fr_auto] items-center gap-1.5">
            {!isCreating && !isEditing && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="text-muted hover:text-foreground inline-flex cursor-pointer items-center border-none bg-transparent p-0 text-base leading-none opacity-0 transition-colors duration-200"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onRemoveWorkspace(workspaceId, e.currentTarget);
                    }}
                    aria-label={`Remove workspace ${displayName}`}
                    data-workspace-id={workspaceId}
                  >
                    ×
                  </button>
                </TooltipTrigger>
                <TooltipContent align="start">Remove workspace</TooltipContent>
              </Tooltip>
            )}
            <RuntimeBadge runtimeConfig={metadata.runtimeConfig} isWorking={canInterrupt} />
            {isEditing ? (
              <input
                className="bg-input-bg text-input-text border-input-border font-inherit focus:border-input-border-focus min-w-0 rounded-sm border px-1 text-left text-[13px] outline-none"
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onKeyDown={handleRenameKeyDown}
                onBlur={() => void handleConfirmRename()}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                aria-label={`Rename workspace ${displayName}`}
                data-workspace-id={workspaceId}
              />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "text-foreground block truncate text-left text-[14px] transition-colors duration-200",
                      !isDisabled && "cursor-pointer"
                    )}
                    onDoubleClick={(e) => {
                      if (isDisabled) return;
                      e.stopPropagation();
                      startRenaming();
                    }}
                    title={isDisabled ? undefined : "Double-click to rename"}
                  >
                    {canInterrupt || isCreating ? (
                      <Shimmer className="w-full truncate" colorClass="var(--color-foreground)">
                        {displayName}
                      </Shimmer>
                    ) : (
                      displayName
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent align="start">Double-click to rename</TooltipContent>
              </Tooltip>
            )}

            {!isCreating && !isEditing && (
              <GitStatusIndicator
                gitStatus={gitStatus}
                workspaceId={workspaceId}
                tooltipPosition="right"
                isWorking={canInterrupt}
              />
            )}
          </div>
          {!isCreating && (
            <div className="ml-[18px] min-w-0">
              {isDeleting ? (
                <div className="text-muted flex min-w-0 items-center gap-1.5 text-xs">
                  <span className="-mt-0.5 shrink-0 text-[10px]">🗑️</span>
                  <span className="min-w-0 truncate">Deleting...</span>
                </div>
              ) : (
                <WorkspaceStatusIndicator workspaceId={workspaceId} />
              )}
            </div>
          )}
        </div>
      </div>
      {renameError && isEditing && (
        <div className="bg-error-bg border-error text-error absolute top-full right-8 left-8 z-10 mt-1 rounded-sm border px-2 py-1.5 text-xs">
          {renameError}
        </div>
      )}
    </React.Fragment>
  );
};

export const WorkspaceListItem = React.memo(WorkspaceListItemInner);
