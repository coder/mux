import { useRename } from "@/browser/contexts/WorkspaceRenameContext";
import { cn } from "@/common/lib/utils";
import { useGitStatus } from "@/browser/stores/GitStatusStore";
import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import React, { useCallback, useState } from "react";
import { GitStatusIndicator } from "./GitStatusIndicator";
import { RuntimeBadge } from "./RuntimeBadge";
import { Tooltip, TooltipWrapper } from "./Tooltip";
import { WorkspaceStatusDot } from "./WorkspaceStatusDot";
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
  lastReadTimestamp: number;
  // Event handlers
  onSelectWorkspace: (selection: WorkspaceSelection) => void;
  onRemoveWorkspace: (workspaceId: string, button: HTMLElement) => Promise<void>;
  onToggleUnread: (workspaceId: string) => void;
}

const WorkspaceListItemInner: React.FC<WorkspaceListItemProps> = ({
  metadata,
  projectPath,
  projectName,
  isSelected,
  isDeleting,
  lastReadTimestamp,
  onSelectWorkspace,
  onRemoveWorkspace,
  onToggleUnread,
}) => {
  // Destructure metadata for convenience
  const { id: workspaceId, name: workspaceName, namedWorkspacePath } = metadata;
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
      e.preventDefault();
      handleCancelRename();
    }
  };

  // Memoize toggle unread handler to prevent AgentStatusIndicator re-renders
  const handleToggleUnread = useCallback(
    () => onToggleUnread(workspaceId),
    [onToggleUnread, workspaceId]
  );

  const { canInterrupt } = useWorkspaceSidebarState(workspaceId);

  return (
    <React.Fragment>
      <div
        className={cn(
          "py-1.5 pl-4 pr-2 cursor-pointer border-l-[3px] border-transparent transition-all duration-150 text-[13px] relative hover:bg-hover [&:hover_button]:opacity-100 flex gap-2",
          isSelected && "bg-hover border-l-blue-400",
          isDeleting && "opacity-50 pointer-events-none"
        )}
        onClick={() =>
          onSelectWorkspace({
            projectPath,
            projectName,
            namedWorkspacePath,
            workspaceId,
          })
        }
        onKeyDown={(e) => {
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
        tabIndex={0}
        aria-current={isSelected ? "true" : undefined}
        aria-label={`Select workspace ${displayName}`}
        data-workspace-path={namedWorkspacePath}
        data-workspace-id={workspaceId}
      >
        <div>
          <WorkspaceStatusDot
            workspaceId={workspaceId}
            lastReadTimestamp={lastReadTimestamp}
            onClick={handleToggleUnread}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <RuntimeBadge runtimeConfig={metadata.runtimeConfig} />
            {isEditing ? (
              <input
                className="bg-input-bg text-input-text border-input-border font-inherit focus:border-input-border-focus -mx-1 min-w-0 flex-1 rounded-sm border px-1 text-left text-[13px] outline-none"
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
              <span
                className="text-foreground -mx-1 min-w-0 flex-1 cursor-pointer truncate rounded-sm px-1 text-left text-[14px] transition-colors duration-200 hover:bg-white/5"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startRenaming();
                }}
                title="Double-click to rename"
              >
                {canInterrupt ? (
                  <Shimmer className="w-full truncate" colorClass="var(--color-foreground)">
                    {displayName}
                  </Shimmer>
                ) : (
                  displayName
                )}
              </span>
            )}

            <div className="ml-auto flex items-center gap-1">
              <GitStatusIndicator
                gitStatus={gitStatus}
                workspaceId={workspaceId}
                tooltipPosition="right"
              />

              <TooltipWrapper inline>
                <button
                  className="text-muted hover:text-foreground col-start-1 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center border-none bg-transparent p-0 text-base opacity-0 transition-all duration-200 hover:rounded-sm hover:bg-white/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    void onRemoveWorkspace(workspaceId, e.currentTarget);
                  }}
                  aria-label={`Remove workspace ${displayName}`}
                  data-workspace-id={workspaceId}
                >
                  ×
                </button>
                <Tooltip className="tooltip" align="right">
                  Remove workspace
                </Tooltip>
              </TooltipWrapper>
            </div>
          </div>
          <div className="min-w-0">
            {isDeleting ? (
              <div className="text-muted flex min-w-0 items-center gap-1.5 text-xs">
                <span className="-mt-0.5 shrink-0 text-[10px]">🗑️</span>
                <span className="min-w-0 truncate">Deleting...</span>
              </div>
            ) : (
              <WorkspaceStatusIndicator workspaceId={workspaceId} />
            )}
          </div>
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
