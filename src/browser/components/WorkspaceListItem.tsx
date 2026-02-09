import { useRename } from "@/browser/contexts/WorkspaceRenameContext";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { cn } from "@/common/lib/utils";
import { useGitStatus } from "@/browser/stores/GitStatusStore";
import { useWorkspaceUnread } from "@/browser/hooks/useWorkspaceUnread";
import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { useWorkspaceFallbackModel } from "@/browser/hooks/useWorkspaceFallbackModel";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import React, { useState, useEffect } from "react";
import { useDrag } from "react-dnd";
import { getEmptyImage } from "react-dnd-html5-backend";
import { GitStatusIndicator } from "./GitStatusIndicator";

import { WorkspaceHoverPreview } from "./WorkspaceHoverPreview";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "./ui/hover-card";
import { Popover, PopoverContent, PopoverTrigger, PopoverAnchor } from "./ui/popover";
import { Pencil, Trash2, Ellipsis, Loader2, Link2 } from "lucide-react";
import { WorkspaceStatusIndicator } from "./WorkspaceStatusIndicator";
import { Shimmer } from "./ai-elements/shimmer";
import { ArchiveIcon } from "./icons/ArchiveIcon";
import { WORKSPACE_DRAG_TYPE, type WorkspaceDragItem } from "./WorkspaceSectionDropZone";
import { useLinkSharingEnabled } from "@/browser/contexts/TelemetryEnabledContext";
import { formatKeybind, matchesKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { ShareTranscriptDialog } from "./ShareTranscriptDialog";

const RADIX_PORTAL_WRAPPER_SELECTOR = "[data-radix-popper-content-wrapper]" as const;

/** Prevent HoverCard from closing when interacting with nested Radix portals (e.g., RuntimeBadge tooltip) */
function preventHoverCardDismissForRadixPortals(e: {
  target: EventTarget | null;
  preventDefault: () => void;
}) {
  const target = e.target;
  if (target instanceof HTMLElement && target.closest(RADIX_PORTAL_WRAPPER_SELECTOR)) {
    e.preventDefault();
  }
}

export interface WorkspaceSelection {
  projectPath: string;
  projectName: string;
  namedWorkspacePath: string; // Worktree path (directory uses workspace name)
  workspaceId: string;
}

/** Props for draft workspace rendering (UI-only placeholders) */
export interface DraftWorkspaceData {
  draftId: string;
  draftNumber: number;
  /** Title derived from draft name state */
  title: string;
  /** Collapsed prompt preview text */
  promptPreview: string;
  onOpen: () => void;
  onDelete: () => void;
}

/** Base props shared by both workspace and draft items */
interface WorkspaceListItemBaseProps {
  projectPath: string;
  isSelected: boolean;
  depth?: number;
}

/** Props for regular (persisted) workspace items */
export interface WorkspaceListItemProps extends WorkspaceListItemBaseProps {
  variant?: "workspace";
  metadata: FrontendWorkspaceMetadata;
  projectName: string;
  isArchiving?: boolean;
  /** True when deletion is in-flight (optimistic UI while backend removes). */
  isRemoving?: boolean;
  /** Section ID this workspace belongs to (for drag-drop targeting) */
  sectionId?: string;
  onSelectWorkspace: (selection: WorkspaceSelection) => void;
  onArchiveWorkspace: (workspaceId: string, button: HTMLElement) => Promise<void>;
  onCancelCreation: (workspaceId: string) => Promise<void>;
}

/** Props for draft (UI-only placeholder) items */
export interface DraftWorkspaceListItemProps extends WorkspaceListItemBaseProps {
  variant: "draft";
  draft: DraftWorkspaceData;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared components and utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Container styles shared between workspace and draft items */
const LIST_ITEM_BASE_CLASSES =
  "py-1.5 pr-2 transition-all duration-150 text-[13px] relative flex gap-2";

/** Calculate left padding based on nesting depth */
function getItemPaddingLeft(depth?: number): number {
  const safeDepth = typeof depth === "number" && Number.isFinite(depth) ? Math.max(0, depth) : 0;
  return 12 + Math.min(32, safeDepth) * 12;
}

/** Selection/unread indicator bar (absolute positioned on left edge) */
function SelectionBar(props: { isSelected: boolean; showUnread?: boolean; isDraft?: boolean }) {
  const barColorClass = props.isSelected
    ? "bg-blue-400"
    : props.showUnread
      ? "bg-muted-foreground"
      : "bg-transparent";

  const bar = (
    <span
      className={cn(
        "absolute left-0 top-0 bottom-0 w-[3px] transition-colors duration-150",
        barColorClass,
        // Dashed border effect for drafts when selected
        props.isDraft && props.isSelected && "bg-[length:3px_6px] bg-repeat-y",
        props.showUnread ? "pointer-events-auto" : "pointer-events-none"
      )}
      style={
        props.isDraft && props.isSelected
          ? {
              background:
                "repeating-linear-gradient(to bottom, var(--color-blue-400) 0px, var(--color-blue-400) 4px, transparent 4px, transparent 8px)",
            }
          : undefined
      }
      aria-hidden={!props.showUnread}
    />
  );

  if (props.showUnread) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{bar}</TooltipTrigger>
        <TooltipContent align="start">Unread messages</TooltipContent>
      </Tooltip>
    );
  }

  return bar;
}

/** Action button wrapper (archive/delete) with consistent sizing and alignment */
function ActionButtonWrapper(props: { hasSubtitle: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("relative inline-flex h-4 w-4 shrink-0 items-center self-center")}>
      {/* Keep the hamburger vertically centered even for single-row items. */}
      {props.children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Draft Workspace Item (UI-only placeholder)
// ─────────────────────────────────────────────────────────────────────────────

function DraftWorkspaceListItemInner(props: DraftWorkspaceListItemProps) {
  const { projectPath, isSelected, depth, draft } = props;
  const paddingLeft = getItemPaddingLeft(depth);
  const hasPromptPreview = draft.promptPreview.length > 0;

  return (
    <div
      className={cn(
        LIST_ITEM_BASE_CLASSES,
        "cursor-pointer hover:bg-hover [&:hover_button]:opacity-100",
        isSelected && "bg-hover"
      )}
      style={{ paddingLeft }}
      onClick={draft.onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          draft.onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      aria-current={isSelected ? "true" : undefined}
      aria-label={`Open workspace draft ${draft.draftNumber}`}
      data-project-path={projectPath}
      data-draft-id={draft.draftId}
    >
      <SelectionBar isSelected={isSelected} isDraft />

      <ActionButtonWrapper hasSubtitle={hasPromptPreview}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-muted hover:text-foreground inline-flex h-4 w-4 cursor-pointer items-center justify-center border-none bg-transparent p-0 opacity-0 transition-colors duration-200"
              onKeyDown={stopKeyboardPropagation}
              onClick={(e) => {
                e.stopPropagation();
                draft.onDelete();
              }}
              aria-label={`Delete workspace draft ${draft.draftNumber}`}
              data-project-path={projectPath}
              data-draft-id={draft.draftId}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent align="start">Delete draft</TooltipContent>
        </Tooltip>
      </ActionButtonWrapper>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-foreground block truncate text-left text-[13px] italic">
          {draft.title}
        </span>
        {hasPromptPreview && (
          <span className="text-muted block truncate text-left text-xs">{draft.promptPreview}</span>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Regular Workspace Item (persisted workspace)
// ─────────────────────────────────────────────────────────────────────────────

function RegularWorkspaceListItemInner(props: WorkspaceListItemProps) {
  const {
    metadata,
    projectPath,
    projectName,
    isSelected,
    isArchiving,
    isRemoving: isRemovingProp,
    depth,
    sectionId,
    onSelectWorkspace,
    onArchiveWorkspace,
    onCancelCreation,
  } = props;

  // Destructure metadata for convenience
  const { id: workspaceId, namedWorkspacePath } = metadata;
  const isMuxHelpChat = workspaceId === MUX_HELP_CHAT_WORKSPACE_ID;
  const isInitializing = metadata.isInitializing === true;
  const isRemoving = isRemovingProp === true || metadata.isRemoving === true;
  const isDisabled = isRemoving || isArchiving === true;

  const { isUnread } = useWorkspaceUnread(workspaceId);
  const gitStatus = useGitStatus(workspaceId);

  // Get title edit context (renamed from rename context since we now edit titles, not names)
  const { editingWorkspaceId, requestRename, confirmRename, cancelRename } = useRename();

  // Local state for title editing
  const [editingTitle, setEditingTitle] = useState<string>("");
  const [titleError, setTitleError] = useState<string | null>(null);

  // Display title (fallback to name for legacy workspaces without title)
  const displayTitle = metadata.title ?? metadata.name;
  const isEditing = editingWorkspaceId === workspaceId;

  const linkSharingEnabled = useLinkSharingEnabled();
  const [shareTranscriptOpen, setShareTranscriptOpen] = useState(false);

  // Hover hamburger menu for discoverable title editing (requested to replace the double-click hint).
  const [isTitleMenuOpen, setIsTitleMenuOpen] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(
    null
  );

  useEffect(() => {
    if (isEditing) {
      setIsTitleMenuOpen(false);
      setContextMenuPosition(null);
    }
  }, [isEditing]);

  // Keybind for opening transcript share popover (only for the selected workspace)
  useEffect(() => {
    if (!isSelected || linkSharingEnabled !== true) return;

    const handler = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.SHARE_TRANSCRIPT)) {
        e.preventDefault();
        setShareTranscriptOpen(true);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isSelected, linkSharingEnabled]);

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
    // Always stop propagation to prevent parent div's onKeyDown and global handlers from interfering
    stopKeyboardPropagation(e);
    if (e.key === "Enter") {
      e.preventDefault();
      void handleConfirmEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  const { canInterrupt, awaitingUserQuestion, isStarting, agentStatus } =
    useWorkspaceSidebarState(workspaceId);

  const fallbackModel = useWorkspaceFallbackModel(workspaceId);
  const isWorking = (canInterrupt || isStarting) && !awaitingUserQuestion;
  const hasStatusText =
    Boolean(agentStatus) || awaitingUserQuestion || isWorking || isInitializing || isRemoving;
  // Note: we intentionally render the secondary row even while the workspace is still
  // initializing so users can see early streaming/status information immediately.
  const hasSecondaryRow = isArchiving === true || hasStatusText;

  const showUnreadBar = !isInitializing && !isEditing && isUnread && !(isSelected && !isDisabled);
  const paddingLeft = getItemPaddingLeft(depth);

  // Drag handle for moving workspace between sections
  const [{ isDragging }, drag, dragPreview] = useDrag(
    () => ({
      type: WORKSPACE_DRAG_TYPE,
      item: (): WorkspaceDragItem & { displayTitle?: string; runtimeConfig?: unknown } => ({
        type: WORKSPACE_DRAG_TYPE,
        workspaceId,
        projectPath,
        currentSectionId: sectionId,
        // Extra fields for custom drag layer preview
        displayTitle,
        runtimeConfig: metadata.runtimeConfig,
      }),
      collect: (monitor) => ({
        isDragging: monitor.isDragging(),
      }),
      canDrag: !isDisabled,
    }),
    [workspaceId, projectPath, sectionId, isDisabled, displayTitle, metadata.runtimeConfig]
  );

  // Hide native drag preview; we render a custom preview via WorkspaceDragLayer
  useEffect(() => {
    dragPreview(getEmptyImage(), { captureDraggingState: true });
  }, [dragPreview]);

  return (
    <React.Fragment>
      <div
        ref={drag}
        className={cn(
          LIST_ITEM_BASE_CLASSES,
          isDragging && "opacity-50",
          isRemoving && "opacity-70",
          // Keep hover styles enabled for initializing workspaces so the row feels interactive.
          !isArchiving && "hover:bg-hover [&:hover_button]:opacity-100",
          isArchiving && "pointer-events-none opacity-70",
          isDisabled ? "cursor-default" : "cursor-pointer",
          isSelected && !isDisabled && "bg-hover"
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
        onContextMenu={(e) => {
          if (isDisabled || isEditing) return;

          e.preventDefault();
          e.stopPropagation();
          setContextMenuPosition({ x: e.clientX, y: e.clientY });
          setIsTitleMenuOpen(true);
        }}
        role="button"
        tabIndex={isDisabled ? -1 : 0}
        aria-current={isSelected ? "true" : undefined}
        aria-label={
          isRemoving
            ? `Deleting workspace ${displayTitle}`
            : isInitializing
              ? `Initializing workspace ${displayTitle}`
              : isArchiving
                ? `Archiving workspace ${displayTitle}`
                : `Select workspace ${displayTitle}`
        }
        aria-disabled={isDisabled}
        data-workspace-path={namedWorkspacePath}
        data-workspace-id={workspaceId}
        data-section-id={sectionId ?? ""}
        data-git-status={gitStatus ? JSON.stringify(gitStatus) : undefined}
      >
        <SelectionBar isSelected={isSelected && !isDisabled} showUnread={showUnreadBar} />

        {/* Action button: cancel/delete spinner for initializing workspaces, overflow menu otherwise */}
        {isInitializing ? (
          <ActionButtonWrapper hasSubtitle={hasStatusText}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "text-muted inline-flex h-4 w-4 items-center justify-center border-none bg-transparent p-0 transition-colors duration-200",
                    // Keep cancel affordance hidden until row-hover while initializing,
                    // but force it visible as a spinner once deletion starts.
                    isRemoving
                      ? "cursor-default opacity-100"
                      : "cursor-pointer opacity-0 hover:text-destructive focus-visible:opacity-100"
                  )}
                  disabled={isRemoving}
                  onKeyDown={stopKeyboardPropagation}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isRemoving) return;
                    void onCancelCreation(workspaceId);
                  }}
                  aria-label={
                    isRemoving
                      ? `Deleting workspace ${displayTitle}`
                      : `Cancel workspace creation ${displayTitle}`
                  }
                  data-workspace-id={workspaceId}
                >
                  {isRemoving ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent align="start">
                {isRemoving ? "Deleting..." : "Cancel creation"}
              </TooltipContent>
            </Tooltip>
          </ActionButtonWrapper>
        ) : (
          !isEditing &&
          !isDisabled && (
            <ActionButtonWrapper hasSubtitle={hasStatusText}>
              {/* Keep the overflow menu in the left action slot to avoid duplicate affordances. */}
              <Popover
                open={isTitleMenuOpen}
                onOpenChange={(open) => {
                  setIsTitleMenuOpen(open);
                  if (!open) setContextMenuPosition(null);
                }}
              >
                {/* When opened via right-click, anchor at click position */}
                {contextMenuPosition && (
                  <PopoverAnchor asChild>
                    <span
                      style={{
                        position: "fixed",
                        left: contextMenuPosition.x,
                        top: contextMenuPosition.y,
                        width: 0,
                        height: 0,
                      }}
                    />
                  </PopoverAnchor>
                )}
                <PopoverTrigger asChild>
                  <button
                    className={cn(
                      "text-muted hover:text-foreground inline-flex h-4 w-4 cursor-pointer items-center justify-center border-none bg-transparent p-0 transition-colors duration-200",
                      // Hidden until row hover, but remain visible while open.
                      isTitleMenuOpen ? "opacity-100" : "opacity-0"
                    )}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Workspace actions for ${displayTitle}`}
                    data-workspace-id={workspaceId}
                  >
                    <Ellipsis className="h-3 w-3" />
                  </button>
                </PopoverTrigger>

                <PopoverContent
                  align={contextMenuPosition ? "start" : "end"}
                  side={contextMenuPosition ? "right" : "bottom"}
                  sideOffset={contextMenuPosition ? 0 : 6}
                  className="w-[250px] !min-w-0 p-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="text-foreground bg-background hover:bg-hover w-full rounded-sm px-2 py-1.5 text-left text-xs whitespace-nowrap"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsTitleMenuOpen(false);
                      startEditing();
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <Pencil className="h-3 w-3 shrink-0" />
                      Edit chat title
                    </span>
                  </button>
                  {/* Share transcript link (gated on telemetry/link-sharing being enabled). */}
                  {linkSharingEnabled === true && !isMuxHelpChat && (
                    <button
                      className="text-foreground bg-background hover:bg-hover w-full rounded-sm px-2 py-1.5 text-left text-xs whitespace-nowrap"
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsTitleMenuOpen(false);
                        setShareTranscriptOpen(true);
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <Link2 className="h-3 w-3 shrink-0" />
                        Share transcript{" "}
                        <span className="text-muted text-[10px]">
                          ({formatKeybind(KEYBINDS.SHARE_TRANSCRIPT)})
                        </span>
                      </span>
                    </button>
                  )}
                  {/* Archive stays in the overflow menu to keep the sidebar row uncluttered. */}
                  {!isMuxHelpChat && (
                    <button
                      className="text-foreground bg-background hover:bg-hover w-full rounded-sm px-2 py-1.5 text-left text-xs whitespace-nowrap"
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsTitleMenuOpen(false);
                        void onArchiveWorkspace(workspaceId, e.currentTarget);
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <ArchiveIcon className="h-3 w-3 shrink-0" />
                        Archive chat{" "}
                        <span className="text-muted text-[10px]">
                          ({formatKeybind(KEYBINDS.ARCHIVE_WORKSPACE)})
                        </span>
                      </span>
                    </button>
                  )}
                </PopoverContent>
              </Popover>
              {/* Share transcript dialog – rendered as a sibling to the overflow menu.
                  Triggered by the menu item above or the Ctrl+Shift+L keybind.
                  Uses a Dialog (modal) so it stays visible regardless of popover dismissal. */}
              {linkSharingEnabled === true && (
                <ShareTranscriptDialog
                  workspaceId={workspaceId}
                  workspaceName={metadata.name}
                  workspaceTitle={displayTitle}
                  open={shareTranscriptOpen}
                  onOpenChange={setShareTranscriptOpen}
                />
              )}
            </ActionButtonWrapper>
          )
        )}

        {/* Split row spacing when there's no secondary line to keep titles centered. */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div
            className={cn(
              "grid min-w-0 grid-cols-[1fr_auto] items-center gap-1.5",
              !hasSecondaryRow && "py-0.5"
            )}
          >
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
              <HoverCard openDelay={300} closeDelay={100}>
                <HoverCardTrigger asChild>
                  <span
                    className={cn(
                      "text-foreground block truncate text-left text-[13px] transition-colors duration-200",
                      !isDisabled && "cursor-pointer"
                    )}
                    onDoubleClick={(e) => {
                      if (isDisabled) return;
                      e.stopPropagation();
                      startEditing();
                    }}
                  >
                    {/* Always render text in same structure; Shimmer just adds animation class */}
                    <Shimmer
                      className={cn(
                        "w-full truncate",
                        !(isWorking || isInitializing) && "no-shimmer"
                      )}
                      colorClass="var(--color-foreground)"
                    >
                      {displayTitle}
                    </Shimmer>
                  </span>
                </HoverCardTrigger>
                <HoverCardContent
                  align="start"
                  side="top"
                  sideOffset={8}
                  className="border-separator-light bg-modal-bg w-auto max-w-[420px] px-[10px] py-[6px] text-[11px] shadow-[0_2px_8px_rgba(0,0,0,0.4)]"
                  onPointerDownOutside={preventHoverCardDismissForRadixPortals}
                  onFocusOutside={preventHoverCardDismissForRadixPortals}
                >
                  <div className="flex flex-col gap-1">
                    <WorkspaceHoverPreview
                      workspaceId={workspaceId}
                      projectName={projectName}
                      workspaceName={metadata.name}
                      namedWorkspacePath={namedWorkspacePath}
                      runtimeConfig={metadata.runtimeConfig}
                      isWorking={isWorking}
                    />
                  </div>
                </HoverCardContent>
              </HoverCard>
            )}

            {!isInitializing && !isEditing && (
              <div className="flex items-center gap-1">
                <GitStatusIndicator
                  gitStatus={gitStatus}
                  workspaceId={workspaceId}
                  projectPath={projectPath}
                  tooltipPosition="right"
                  isWorking={isWorking}
                />
              </div>
            )}
          </div>
          {hasSecondaryRow && (
            <div className="min-w-0">
              {isRemoving ? (
                <div className="text-muted flex min-w-0 items-center gap-1.5 text-xs">
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                  <span className="min-w-0 truncate">Deleting...</span>
                </div>
              ) : isArchiving ? (
                <div className="text-muted flex min-w-0 items-center gap-1.5 text-xs">
                  <ArchiveIcon className="h-3 w-3 shrink-0" />
                  <span className="min-w-0 truncate">Archiving...</span>
                </div>
              ) : (
                <WorkspaceStatusIndicator
                  workspaceId={workspaceId}
                  fallbackModel={fallbackModel}
                  isCreating={isInitializing}
                />
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Export (dispatches based on variant)
// ─────────────────────────────────────────────────────────────────────────────

type UnifiedWorkspaceListItemProps = WorkspaceListItemProps | DraftWorkspaceListItemProps;

function WorkspaceListItemInner(props: UnifiedWorkspaceListItemProps) {
  if (props.variant === "draft") {
    return <DraftWorkspaceListItemInner {...props} />;
  }
  return <RegularWorkspaceListItemInner {...props} />;
}

export const WorkspaceListItem = React.memo(WorkspaceListItemInner);
