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
  depth?: number;
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
  depth,
  lastReadTimestamp: _lastReadTimestamp,
  onSelectWorkspace,
  onRemoveWorkspace,
  onToggleUnread: _onToggleUnread,
}) => {
  // Destructure metadata for convenience
  const { id: workspaceId, namedWorkspacePath, status } = metadata;
  const isCreating = status === "creating";
  const isDisabled = isCreating || isDeleting;
  const gitStatus = useGitStatus(workspaceId);

  // Get title edit context (renamed from rename context since we now edit titles, not names)
  const { editingWorkspaceId, requestRename, confirmRename, cancelRename } = useRename();

  // Local state for title editing
  const [editingTitle, setEditingTitle] = useState<string>("");
  const [titleError, setTitleError] = useState<string | null>(null);

  // Display title (fallback to name for legacy workspaces without title)
  const displayTitle = metadata.title ?? metadata.name;
  const isEditing = editingWorkspaceId === workspaceId;

  const startEditing = () => {
    if (requestRename(workspaceId, displayTitle)) {
      setEditingTitle(displayTitle);
      setTitleError(null);
    }
  };

  const handleConfirmEdit = async () => {
    if (!editingTitle.trim()) {
      setTitleError("Title cannot be empty");
      return;
    }

    const result = await confirmRename(workspaceId, editingTitle);
    if (!result.success) {
      setTitleError(result.error ?? "Failed to update title");
    } else {
      setTitleError(null);
    }
  };

  const handleCancelEdit = () => {
    cancelRename();
    setEditingTitle("");
    setTitleError(null);
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    // Always stop propagation to prevent parent div's onKeyDown from interfering
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void handleConfirmEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  const { canInterrupt, awaitingUserQuestion } = useWorkspaceSidebarState(workspaceId);
  const isWorking = canInterrupt && !awaitingUserQuestion;
  const safeDepth = typeof depth === "number" && Number.isFinite(depth) ? Math.max(0, depth) : 0;
  const paddingLeft = 9 + Math.min(32, safeDepth) * 12;

  return (
    <React.Fragment>
      <div
        className={cn(
          "py-1.5 pr-2 border-l-[3px] border-transparent transition-all duration-150 text-[13px] relative flex gap-2",
          isDisabled
            ? "cursor-default opacity-70"
            : "cursor-pointer hover:bg-hover [&:hover_button]:opacity-100",
          isSelected && !isDisabled && "bg-hover border-l-blue-400",
          isDeleting && "pointer-events-none"
        )}
        style={{ paddingLeft }}
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
          if (isDisabled || isEditing) return;
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
            ? `Creating workspace ${displayTitle}`
            : isDeleting
              ? `Deleting workspace ${displayTitle}`
              : `Select workspace ${displayTitle}`
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
                    aria-label={`Remove workspace ${displayTitle}`}
                    data-workspace-id={workspaceId}
                  >
                    ×
                  </button>
                </TooltipTrigger>
                <TooltipContent align="start">Remove workspace</TooltipContent>
              </Tooltip>
            )}
            <RuntimeBadge runtimeConfig={metadata.runtimeConfig} isWorking={isWorking} />
            {isEditing ? (
              <input
                className="bg-input-bg text-input-text border-input-border font-inherit focus:border-input-border-focus col-span-2 min-w-0 flex-1 rounded-sm border px-1 text-left text-[13px] outline-none"
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onKeyDown={handleEditKeyDown}
                onBlur={() => void handleConfirmEdit()}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                aria-label={`Edit title for workspace ${displayTitle}`}
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
                      startEditing();
                    }}
                    title={isDisabled ? undefined : "Double-click to edit title"}
                  >
                    {isWorking || isCreating ? (
                      <Shimmer className="w-full truncate" colorClass="var(--color-foreground)">
                        {displayTitle}
                      </Shimmer>
                    ) : (
                      displayTitle
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent align="start">Double-click to edit title</TooltipContent>
              </Tooltip>
            )}

            {!isCreating && !isEditing && (
              <GitStatusIndicator
                gitStatus={gitStatus}
                workspaceId={workspaceId}
                tooltipPosition="right"
                isWorking={isWorking}
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
      {titleError && isEditing && (
        <div className="bg-error-bg border-error text-error absolute top-full right-8 left-8 z-10 mt-1 rounded-sm border px-2 py-1.5 text-xs">
          {titleError}
        </div>
      )}
    </React.Fragment>
  );
};

export const WorkspaceListItem = React.memo(WorkspaceListItemInner);
