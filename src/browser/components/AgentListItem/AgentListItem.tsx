import { useTitleEdit } from "@/browser/contexts/WorkspaceTitleEditContext";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import type { AgentRowRenderMeta } from "@/browser/utils/ui/workspaceFiltering";
import { cn } from "@/common/lib/utils";
import { useGitStatus } from "@/browser/stores/GitStatusStore";
import { useWorkspaceUnread } from "@/browser/hooks/useWorkspaceUnread";
import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { useWorkspaceFallbackModel } from "@/browser/hooks/useWorkspaceFallbackModel";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import React, { useState, useEffect, useRef, useCallback } from "react";
import { useDrag } from "react-dnd";
import { getEmptyImage } from "react-dnd-html5-backend";
import { GitStatusIndicator } from "../GitStatusIndicator/GitStatusIndicator";
import { SubAgentListItem } from "./SubAgentListItem";

import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { Popover, PopoverContent, PopoverTrigger, PopoverAnchor } from "../Popover/Popover";
import { useContextMenuPosition } from "@/browser/hooks/useContextMenuPosition";
import { PositionedMenu, PositionedMenuItem } from "../PositionedMenu/PositionedMenu";
import {
  Trash2,
  Trash,
  EllipsisVertical,
  Loader2,
  Sparkles,
  PenLine,
  MessageCircleQuestionMark,
  ChevronRight,
} from "lucide-react";
import { WorkspaceStatusIndicator } from "../WorkspaceStatusIndicator/WorkspaceStatusIndicator";
import { ArchiveIcon } from "../icons/ArchiveIcon/ArchiveIcon";
import { WorkspaceTerminalIcon } from "../icons/WorkspaceTerminalIcon/WorkspaceTerminalIcon";
import {
  WORKSPACE_DRAG_TYPE,
  type WorkspaceDragItem,
} from "../WorkspaceSectionDropZone/WorkspaceSectionDropZone";
import { useLinkSharingEnabled } from "@/browser/contexts/TelemetryEnabledContext";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { ShareTranscriptDialog } from "../ShareTranscriptDialog/ShareTranscriptDialog";
import { WorkspaceActionsMenuContent } from "../WorkspaceActionsMenuContent/WorkspaceActionsMenuContent";
import { useAPI } from "@/browser/contexts/API";

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
interface AgentListItemBaseProps {
  projectPath: string;
  isSelected: boolean;
  depth?: number;
}

/** Props for regular (persisted) workspace items */
export interface AgentListItemProps extends AgentListItemBaseProps {
  variant?: "workspace";
  metadata: FrontendWorkspaceMetadata;
  projectName: string;
  isArchiving?: boolean;
  /** True when deletion is in-flight (optimistic UI while backend removes). */
  isRemoving?: boolean;
  /** Section ID this workspace belongs to (for drag-drop targeting) */
  sectionId?: string;
  rowRenderMeta?: AgentRowRenderMeta;
  completedChildrenExpanded?: boolean;
  onToggleCompletedChildren?: (workspaceId: string) => void;
  onSelectWorkspace: (selection: WorkspaceSelection) => void;
  onForkWorkspace: (workspaceId: string, button: HTMLElement) => Promise<void>;
  onArchiveWorkspace: (workspaceId: string, button: HTMLElement) => Promise<void>;
  onCancelCreation: (workspaceId: string) => Promise<void>;
}

/** Props for draft (UI-only placeholder) items */
export interface DraftAgentListItemProps extends AgentListItemBaseProps {
  variant: "draft";
  draft: DraftWorkspaceData;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared components and utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Container styles shared between workspace and draft items.
 * Keep row text non-selectable so touch/pointer drags don't highlight titles
 * before react-dnd has locked into a drag session.
 */
const LIST_ITEM_BASE_CLASSES =
  "bg-surface-primary relative flex items-start gap-1.5 rounded-l-sm py-2 pr-2 select-none transition-all duration-150";

const HIDE_INLINE_ACTIONS_ON_MOBILE_TOUCH =
  "[@media(max-width:768px)_and_(hover:none)_and_(pointer:coarse)]:invisible [@media(max-width:768px)_and_(hover:none)_and_(pointer:coarse)]:pointer-events-none";
const SHOW_INLINE_ACTIONS_ON_WIDE_TOUCH =
  "[@media(min-width:769px)_and_(hover:none)_and_(pointer:coarse)]:opacity-100";

/** Calculate left padding based on nesting depth */
function getItemPaddingLeft(depth?: number): number {
  const safeDepth = typeof depth === "number" && Number.isFinite(depth) ? Math.max(0, depth) : 0;
  return 12 + Math.min(32, safeDepth) * 12;
}

type VisualState = "active" | "idle" | "seen" | "hidden" | "error" | "question";

function getVisualState(opts: {
  awaitingUserQuestion: boolean;
  isInitializing: boolean;
  isRemoving: boolean;
  isArchiving: boolean;
  isWorking: boolean;
  isStarting: boolean;
  isUnread: boolean;
  isSelected: boolean;
  hasError: boolean;
}): VisualState {
  if (opts.isRemoving || opts.isArchiving) {
    return "hidden";
  }
  if (opts.hasError) {
    return "error";
  }
  if (opts.awaitingUserQuestion) {
    return "question";
  }
  if (opts.isWorking || opts.isStarting || opts.isInitializing) {
    return "active";
  }
  // Avoid unread flicker for the currently selected workspace while last-read
  // timestamps catch up on the next render.
  if (opts.isSelected) {
    return "seen";
  }
  // Figma distinguishes idle unseen (ringed dot + primary title) from seen (subtle square + secondary title).
  return opts.isUnread ? "idle" : "seen";
}

function StatusDot(props: {
  state: VisualState;
  isDraft?: boolean;
  completedChildrenChevronState?: "collapsed" | "expanded";
  completedChildrenChevronLabel?: string;
  onToggleCompletedChildren?: () => void;
  isDisabled?: boolean;
}) {
  const shouldHideDot = !props.isDraft && (props.state === "seen" || props.state === "hidden");
  const indicatorClasses =
    "relative z-20 flex h-4 w-4 shrink-0 items-center justify-center self-center";

  if (props.completedChildrenChevronState) {
    const chevronLabel = props.completedChildrenChevronLabel ?? "workspace";
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (props.isDisabled) {
            return;
          }
          props.onToggleCompletedChildren?.();
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={stopKeyboardPropagation}
        aria-label={
          props.completedChildrenChevronState === "expanded"
            ? `Collapse completed sub-agents for ${chevronLabel}`
            : `Expand completed sub-agents for ${chevronLabel}`
        }
        aria-expanded={props.completedChildrenChevronState === "expanded"}
        disabled={props.isDisabled}
        className={cn(
          indicatorClasses,
          // Reuse the leading dot slot as a real chevron button so completed rows
          // keep an explicit expand affordance without stealing title space.
          "text-muted rounded-sm border-none bg-transparent p-0 transition-colors duration-200",
          !props.isDisabled && "cursor-pointer hover:text-foreground",
          props.isDisabled && "cursor-default opacity-60"
        )}
        data-completed-children-chevron={props.completedChildrenChevronState}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "h-3 w-3 transition-transform duration-200 ease-in-out",
            props.completedChildrenChevronState === "expanded" && "rotate-90"
          )}
        />
      </button>
    );
  }

  const dot = props.isDraft ? (
    <span className="border-border-subtle block h-3 w-3 rounded-full border border-dashed" />
  ) : shouldHideDot ? (
    <span className="block h-3 w-3 opacity-0" />
  ) : (
    <span
      className={cn(
        "block h-3 w-3",
        props.state === "active" &&
          "bg-content-success border-surface-green workspace-status-dot-active",
        props.state === "idle" && "bg-surface-invert-secondary border-surface-tertiary",
        props.state === "error" && "bg-content-destructive border-surface-destructive",
        props.state === "question" && "bg-border-pending border-surface-sky",
        "rounded-full border-[3.5px]"
      )}
    />
  );

  return (
    // Keep the dot centered relative to the full row height so multi-line rows
    // (for example while streaming) do not pin the icon to the title line.
    <div
      // Keep the leading indicator above sub-agent connector overlays so branch
      // lines do not draw across either the status dot or completed-child chevron
      // when rows are nested.
      className={indicatorClasses}
    >
      {dot}
    </div>
  );
}

/** Action button wrapper (archive/delete) with consistent sizing and alignment */
function ActionButtonWrapper(props: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "relative order-last ml-auto mt-1 inline-flex h-4 w-4 shrink-0 items-center self-start"
      )}
    >
      {/* Keep the kebab trigger aligned with the title row. */}
      {props.children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Draft Workspace Item (UI-only placeholder)
// ─────────────────────────────────────────────────────────────────────────────

function DraftAgentListItemInner(props: DraftAgentListItemProps) {
  const { projectPath, isSelected, depth, draft } = props;
  const paddingLeft = getItemPaddingLeft(depth);
  const hasPromptPreview = draft.promptPreview.length > 0;

  const ctxMenu = useContextMenuPosition({ longPress: true });

  return (
    <div
      className={cn(
        LIST_ITEM_BASE_CLASSES,
        "border-border cursor-pointer border-t border-b border-l border-dashed pl-1 hover:bg-surface-secondary [&:hover_button]:opacity-100",
        isSelected && "bg-surface-secondary"
      )}
      style={{ paddingLeft }}
      onClick={() => {
        if (ctxMenu.suppressClickIfLongPress()) return;
        draft.onOpen();
      }}
      {...ctxMenu.touchHandlers}
      onContextMenu={ctxMenu.onContextMenu}
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
      <StatusDot state="idle" isDraft />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1 text-[14px] leading-6">
          <PenLine
            className={cn("h-3 w-3 shrink-0", isSelected ? "text-foreground" : "text-muted")}
          />
          <span
            className={cn(
              "min-w-0 truncate text-left italic",
              isSelected ? "text-foreground" : "text-muted"
            )}
          >
            {draft.title}
          </span>
        </div>
        {hasPromptPreview && (
          <span
            className={cn(
              "block truncate text-left text-xs leading-4",
              isSelected ? "text-foreground" : "text-muted"
            )}
          >
            {draft.promptPreview}
          </span>
        )}
      </div>

      <ActionButtonWrapper>
        {/* Inline delete button stays hidden only on the narrow touch sidebar. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "text-muted hover:text-foreground inline-flex h-4 w-4 cursor-pointer items-center justify-center border-none bg-transparent p-0 opacity-0 transition-colors duration-200",
                // Keep long-press as the compact mobile affordance on narrow
                // touch layouts, but show the button on wider touch screens so
                // it never becomes an invisible tappable hotspot.
                HIDE_INLINE_ACTIONS_ON_MOBILE_TOUCH,
                SHOW_INLINE_ACTIONS_ON_WIDE_TOUCH
              )}
              onKeyDown={stopKeyboardPropagation}
              onClick={(e) => {
                e.stopPropagation();
                draft.onDelete();
              }}
              aria-label={`Delete workspace draft ${draft.draftNumber}`}
              data-project-path={projectPath}
              data-draft-id={draft.draftId}
            >
              <Trash className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent align="start">Delete draft</TooltipContent>
        </Tooltip>

        {/* Mobile: context menu opened by long-press / right-click */}
        <PositionedMenu
          open={ctxMenu.isOpen}
          onOpenChange={ctxMenu.onOpenChange}
          position={ctxMenu.position}
          className="w-[150px]"
        >
          <PositionedMenuItem
            icon={<Trash />}
            label="Delete draft"
            onClick={() => {
              ctxMenu.close();
              draft.onDelete();
            }}
          />
        </PositionedMenu>
      </ActionButtonWrapper>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Regular Workspace Item (persisted workspace)
// ─────────────────────────────────────────────────────────────────────────────

function RegularAgentListItemInner(props: AgentListItemProps) {
  const {
    metadata,
    projectPath,
    projectName,
    isSelected,
    isArchiving,
    isRemoving: isRemovingProp,
    depth,
    sectionId,
    rowRenderMeta,
    completedChildrenExpanded,
    onToggleCompletedChildren,
    onSelectWorkspace,
    onForkWorkspace,
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

  // Get title edit context — manages inline title editing state across the sidebar
  const {
    editingWorkspaceId,
    requestEdit,
    confirmEdit,
    cancelEdit,
    generatingTitleWorkspaceIds,
    wrapGenerateTitle,
  } = useTitleEdit();
  const isGeneratingTitle = generatingTitleWorkspaceIds.has(workspaceId);
  const { api } = useAPI();

  // Local state for title editing
  const [editingTitle, setEditingTitle] = useState<string>("");
  const [titleError, setTitleError] = useState<string | null>(null);

  // Display title (fallback to name for legacy workspaces without title)
  const displayTitle = metadata.title ?? metadata.name;
  const isEditing = editingWorkspaceId === workspaceId;

  const linkSharingEnabled = useLinkSharingEnabled();
  const [shareTranscriptOpen, setShareTranscriptOpen] = useState(false);
  const overflowMenuFrameRef = useRef<number | null>(null);

  // Context menu via right-click / long-press. The hook manages position + long-press state.
  // The regular item also has a ⋮ trigger button, so we bridge the hook's isOpen into a
  // Popover that can be anchored either at the cursor position or the trigger button.
  const canOpenMenu = useCallback(() => !isDisabled && !isEditing, [isDisabled, isEditing]);
  const ctxMenu = useContextMenuPosition({ longPress: true, canOpen: canOpenMenu });
  // Hide menu content for one frame while Radix/Floating UI recalculates anchor
  // placement. This avoids first-frame flashes at stale trigger/fallback coords.
  const setOverflowMenuContentRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (overflowMenuFrameRef.current !== null) {
        cancelAnimationFrame(overflowMenuFrameRef.current);
        overflowMenuFrameRef.current = null;
      }

      if (!node || !ctxMenu.isOpen) {
        return;
      }

      node.style.visibility = "hidden";
      overflowMenuFrameRef.current = requestAnimationFrame(() => {
        overflowMenuFrameRef.current = null;
        if (!node.isConnected) {
          return;
        }
        node.style.visibility = "visible";
      });
    },
    [ctxMenu.isOpen]
  );

  useEffect(() => {
    if (isEditing) {
      ctxMenu.close();
    }
  }, [isEditing, ctxMenu]);

  const wasEditingRef = useRef(false);
  useEffect(() => {
    if (isEditing && !wasEditingRef.current) {
      // Initialize draft title exactly once per edit session so metadata refreshes
      // never overwrite what the user has typed in the input.
      setEditingTitle(displayTitle);
      setTitleError(null);
    }
    wasEditingRef.current = isEditing;
  }, [isEditing, displayTitle]);

  const handleEditInputRef = useCallback((node: HTMLInputElement | null) => {
    if (!node) {
      return;
    }

    node.focus();
  }, []);

  // SHARE_TRANSCRIPT keybind is handled in WorkspaceMenuBar (always mounted),
  // so it works even when the sidebar is collapsed and list items are unmounted.

  const startEditing = () => {
    if (requestEdit(workspaceId, displayTitle)) {
      setEditingTitle(displayTitle);
      setTitleError(null);
    }
  };

  const handleConfirmEdit = async () => {
    if (!editingTitle.trim()) {
      setTitleError("Title cannot be empty");
      return;
    }

    const result = await confirmEdit(workspaceId, editingTitle);
    if (!result.success) {
      setTitleError(result.error ?? "Failed to update title");
    } else {
      setTitleError(null);
    }
  };

  const handleCancelEdit = () => {
    cancelEdit();
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

  const {
    canInterrupt,
    awaitingUserQuestion,
    isStarting,
    agentStatus,
    terminalActiveCount,
    lastAbortReason,
  } = useWorkspaceSidebarState(workspaceId);

  const fallbackModel = useWorkspaceFallbackModel(workspaceId);
  const isWorking = (canInterrupt || isStarting) && !awaitingUserQuestion;
  const hasError = lastAbortReason?.reason === "system";
  const visualState = getVisualState({
    awaitingUserQuestion,
    isInitializing,
    isRemoving,
    isArchiving: isArchiving === true,
    isWorking,
    isStarting,
    isUnread,
    isSelected,
    hasError,
  });
  const hasStatusText =
    Boolean(agentStatus) || awaitingUserQuestion || isWorking || isInitializing || isRemoving;
  // Note: we intentionally render the secondary row even while the workspace is still
  // initializing so users can see early streaming/status information immediately.
  const hasSecondaryRow = isArchiving === true || hasStatusText;
  const hasCompletedChildren =
    (rowRenderMeta?.hasHiddenCompletedChildren ?? false) ||
    (rowRenderMeta?.visibleCompletedChildrenCount ?? 0) > 0;
  const canToggleCompletedChildren = hasCompletedChildren && onToggleCompletedChildren != null;
  const isCompletedChildrenExpanded = completedChildrenExpanded === true;
  const completedChildrenChevronState =
    canToggleCompletedChildren && visualState === "seen"
      ? isCompletedChildrenExpanded
        ? "expanded"
        : "collapsed"
      : undefined;
  const toggleCompletedChildren = () => {
    if (!canToggleCompletedChildren) {
      return false;
    }
    onToggleCompletedChildren?.(workspaceId);
    return true;
  };

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
          !isArchiving && "pl-1 hover:bg-surface-secondary [&:hover_button]:opacity-100",
          isArchiving && "pointer-events-none opacity-70",
          isDisabled ? "cursor-default" : "cursor-pointer",
          isSelected && !isDisabled && "bg-surface-secondary"
        )}
        style={{ paddingLeft }}
        onClick={() => {
          if (isDisabled) return;
          if (ctxMenu.suppressClickIfLongPress()) return;
          onSelectWorkspace({
            projectPath,
            projectName,
            namedWorkspacePath,
            workspaceId,
          });
        }}
        {...ctxMenu.touchHandlers}
        onKeyDown={(e) => {
          if (isDisabled || isEditing) return;
          // Only treat these shortcuts as row-level controls when the row itself is
          // focused so child buttons keep their own keyboard behavior.
          if (e.target !== e.currentTarget) return;
          // Keep completed-child expansion reachable from the focused row even
          // though pointer users now toggle it from the dedicated chevron button.
          if (
            e.key === "ArrowRight" &&
            canToggleCompletedChildren &&
            !isCompletedChildrenExpanded
          ) {
            e.preventDefault();
            e.stopPropagation();
            toggleCompletedChildren();
            return;
          }
          if (e.key === "ArrowLeft" && canToggleCompletedChildren && isCompletedChildrenExpanded) {
            e.preventDefault();
            e.stopPropagation();
            toggleCompletedChildren();
            return;
          }
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
        onContextMenu={ctxMenu.onContextMenu}
        role="button"
        tabIndex={isDisabled ? -1 : 0}
        aria-current={isSelected ? "true" : undefined}
        aria-expanded={canToggleCompletedChildren ? isCompletedChildrenExpanded : undefined}
        aria-keyshortcuts={canToggleCompletedChildren ? "ArrowRight ArrowLeft" : undefined}
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
        <StatusDot
          state={visualState}
          completedChildrenChevronState={completedChildrenChevronState}
          completedChildrenChevronLabel={displayTitle}
          onToggleCompletedChildren={toggleCompletedChildren}
          isDisabled={isDisabled}
        />

        {/* Action button: cancel/delete spinner for initializing workspaces, overflow menu otherwise */}
        {isInitializing ? (
          <ActionButtonWrapper>
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
        ) : isDisabled ? (
          // Invisible spacer preserves title alignment during archive/remove transitions
          <div className="order-last ml-auto h-4 w-4 shrink-0" />
        ) : (
          !isEditing && (
            <ActionButtonWrapper>
              {/* Overflow menu: opens from ⋮ button (dropdown) or right-click/long-press (positioned).
                  Uses a Popover so it can anchor at either the trigger button or the cursor. */}
              <Popover open={ctxMenu.isOpen} onOpenChange={ctxMenu.onOpenChange}>
                {/* When opened via right-click/long-press, anchor at cursor position */}
                {ctxMenu.position && (
                  <PopoverAnchor asChild>
                    <span
                      style={{
                        position: "fixed",
                        left: ctxMenu.position.x,
                        top: ctxMenu.position.y,
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
                      ctxMenu.isOpen ? "opacity-100" : "opacity-0",
                      HIDE_INLINE_ACTIONS_ON_MOBILE_TOUCH,
                      SHOW_INLINE_ACTIONS_ON_WIDE_TOUCH
                    )}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Workspace actions for ${displayTitle}`}
                    data-workspace-id={workspaceId}
                  >
                    <EllipsisVertical className="h-3 w-3" />
                  </button>
                </PopoverTrigger>

                <PopoverContent
                  ref={setOverflowMenuContentRef}
                  align={ctxMenu.position ? "start" : "end"}
                  side={ctxMenu.position ? "right" : "bottom"}
                  sideOffset={ctxMenu.position ? 0 : 6}
                  className="w-[250px] !min-w-0 p-1"
                  onClick={(event: React.MouseEvent<HTMLDivElement>) => {
                    event.stopPropagation();
                  }}
                >
                  <WorkspaceActionsMenuContent
                    onEditTitle={startEditing}
                    onForkChat={(anchorEl) => {
                      void onForkWorkspace(workspaceId, anchorEl);
                    }}
                    onShareTranscript={() => setShareTranscriptOpen(true)}
                    onArchiveChat={(anchorEl) => {
                      void onArchiveWorkspace(workspaceId, anchorEl);
                    }}
                    onCloseMenu={() => ctxMenu.close()}
                    linkSharingEnabled={linkSharingEnabled === true}
                    isMuxHelpChat={isMuxHelpChat}
                  />
                  <PositionedMenuItem
                    icon={<Sparkles />}
                    label="Generate new title"
                    shortcut={formatKeybind(KEYBINDS.GENERATE_WORKSPACE_TITLE)}
                    onClick={() => {
                      ctxMenu.close();
                      wrapGenerateTitle(workspaceId, () => {
                        if (!api) {
                          return Promise.resolve({
                            success: false,
                            error: "Not connected to server",
                          });
                        }
                        return api.workspace.regenerateTitle({ workspaceId });
                      });
                    }}
                  />
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

        {/* Keep title row anchored so status dot/title align across single+double-line states. */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div
            className={cn(
              // Keep the title column shrinkable on narrow/mobile viewports so the
              // right-side git indicator never forces horizontal sidebar scrolling.
              "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5"
            )}
          >
            {isEditing ? (
              <input
                className="bg-input-bg text-input-text border-input-border font-inherit focus:border-input-border-focus col-span-2 min-w-0 flex-1 rounded-sm border px-1 text-left text-[13px] outline-none select-text"
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onKeyDown={handleEditKeyDown}
                onBlur={() => void handleConfirmEdit()}
                ref={handleEditInputRef}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Edit title for workspace ${displayTitle}`}
                data-workspace-id={workspaceId}
              />
            ) : (
              <div className="flex min-w-0 items-center gap-1">
                <span
                  className={cn(
                    "text-foreground min-w-0 flex-1 truncate text-left text-[14px] leading-6 transition-colors duration-200",
                    !isDisabled && "cursor-pointer",
                    isGeneratingTitle && "italic",
                    !isSelected && visualState === "seen" && "text-secondary"
                  )}
                  onDoubleClick={(event) => {
                    if (isDisabled) {
                      return;
                    }
                    // Keep rename scoped to the title itself so parent rows can use
                    // the leading chevron for completed-child expansion without
                    // turning the whole row into an ambiguous double-click target.
                    event.stopPropagation();
                    startEditing();
                  }}
                  data-workspace-title
                >
                  {displayTitle}
                </span>
              </div>
            )}

            {!isInitializing && !isEditing && (
              <div className="flex items-center gap-1">
                {terminalActiveCount > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="text-muted flex items-center gap-0.5">
                        <WorkspaceTerminalIcon className="h-3 w-3" />
                        <span className="text-[11px]">{terminalActiveCount}</span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {terminalActiveCount} terminal{terminalActiveCount !== 1 ? "s" : ""} running
                      commands
                    </TooltipContent>
                  </Tooltip>
                )}
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
              ) : awaitingUserQuestion ? (
                <div className="text-muted flex min-w-0 items-center gap-1.5 text-xs leading-4">
                  <MessageCircleQuestionMark className="h-3 w-3 shrink-0" />
                  <span className="min-w-0 truncate">Mux has a few questions</span>
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

type UnifiedAgentListItemProps = AgentListItemProps | DraftAgentListItemProps;

function AgentListItemInner(props: UnifiedAgentListItemProps) {
  if (props.variant === "draft") {
    return <DraftAgentListItemInner {...props} />;
  }

  const rowMeta = props.rowRenderMeta;
  if (rowMeta?.rowKind === "subagent") {
    // Connector geometry is driven by render metadata so visible siblings keep
    // consistent single/middle/last shapes as parents expand/collapse children.
    return (
      <SubAgentListItem
        connectorPosition={rowMeta.connectorPosition}
        indentLeft={getItemPaddingLeft(props.depth)}
        isSelected={props.isSelected}
      >
        <RegularAgentListItemInner {...props} />
      </SubAgentListItem>
    );
  }

  return <RegularAgentListItemInner {...props} />;
}

export const AgentListItem = React.memo(AgentListItemInner);
