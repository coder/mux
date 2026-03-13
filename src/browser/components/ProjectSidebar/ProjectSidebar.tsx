import React, { useState, useEffect, useCallback, useRef } from "react";
import { cn } from "@/common/lib/utils";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import MuxLogoDark from "@/browser/assets/logos/mux-logo-dark.svg?react";
import MuxLogoLight from "@/browser/assets/logos/mux-logo-light.svg?react";
import { useTheme } from "@/browser/contexts/ThemeContext";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import { useDebouncedValue } from "@/browser/hooks/useDebouncedValue";
import { useWorkspaceFallbackModel } from "@/browser/hooks/useWorkspaceFallbackModel";
import { useWorkspaceUnread } from "@/browser/hooks/useWorkspaceUnread";
import { useRuntimeStatusStoreRaw } from "@/browser/stores/RuntimeStatusStore";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import {
  EXPANDED_PROJECTS_KEY,
  MOBILE_LEFT_SIDEBAR_SCROLL_TOP_KEY,
  getDraftScopeId,
  getInputKey,
  getWorkspaceNameStateKey,
} from "@/common/constants/storage";
import { getDisplayTitleFromPersistedState } from "@/browser/hooks/useWorkspaceName";
import { DndProvider } from "react-dnd";
import { HTML5Backend, getEmptyImage } from "react-dnd-html5-backend";
import { useDrag, useDrop, useDragLayer } from "react-dnd";
import {
  sortProjectsByOrder,
  reorderProjects,
  normalizeOrder,
} from "@/common/utils/projectOrdering";
import {
  matchesKeybind,
  formatKeybind,
  isEditableElement,
  KEYBINDS,
} from "@/browser/utils/ui/keybinds";
import { useAPI } from "@/browser/contexts/API";
import { CUSTOM_EVENTS, type CustomEventType } from "@/common/constants/events";
import { PlatformPaths } from "@/common/utils/paths";
import {
  partitionWorkspacesByAge,
  partitionWorkspacesBySection,
  formatDaysThreshold,
  AGE_THRESHOLDS_DAYS,
  computeWorkspaceDepthMap,
  filterVisibleAgentRows,
  computeAgentRowRenderMeta,
  findNextNonEmptyTier,
  getTierKey,
  getSectionExpandedKey,
  getSectionTierKey,
  sortSectionsByLinkedList,
  type AgentRowRenderMeta,
} from "@/browser/utils/ui/workspaceFiltering";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { SidebarCollapseButton } from "../SidebarCollapseButton/SidebarCollapseButton";
import { ConfirmationModal } from "../ConfirmationModal/ConfirmationModal";
import { ProjectDeleteConfirmationModal } from "../ProjectDeleteConfirmationModal/ProjectDeleteConfirmationModal";
import { useSettings } from "@/browser/contexts/SettingsContext";

import { AgentListItem, type WorkspaceSelection } from "../AgentListItem/AgentListItem";
import { BestOfGroupListItem } from "./BestOfGroupListItem";
import { WorkspaceStatusIndicator } from "../WorkspaceStatusIndicator/WorkspaceStatusIndicator";
import { TitleEditProvider, useTitleEdit } from "@/browser/contexts/WorkspaceTitleEditContext";
import { useConfirmDialog } from "@/browser/contexts/ConfirmDialogContext";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { ChevronRight, CircleHelp, KeyRound } from "lucide-react";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { useWorkspaceActions } from "@/browser/contexts/WorkspaceContext";
import { useRouter } from "@/browser/contexts/RouterContext";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import { forkWorkspace } from "@/browser/utils/chatCommands";
import { PopoverError } from "../PopoverError/PopoverError";
import { SectionHeader } from "../SectionHeader/SectionHeader";
import { AddSectionButton } from "../AddSectionButton/AddSectionButton";
import { WorkspaceSectionDropZone } from "../WorkspaceSectionDropZone/WorkspaceSectionDropZone";
import { WorkspaceDragLayer } from "../WorkspaceDragLayer/WorkspaceDragLayer";
import { SectionDragLayer } from "../SectionDragLayer/SectionDragLayer";
import { DraggableSection } from "../DraggableSection/DraggableSection";
import type { SectionConfig } from "@/common/types/project";
import { getErrorMessage } from "@/common/utils/errors";
import { isMultiProject } from "@/common/utils/multiProject";
import { MULTI_PROJECT_SIDEBAR_SECTION_ID } from "@/common/constants/multiProject";
import { getProjectWorkspaceCounts } from "@/common/utils/projectRemoval";
import { hasCompletedAgentReport } from "@/common/utils/agentTaskCompletion";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";

// Re-export WorkspaceSelection for backwards compatibility
export type { WorkspaceSelection } from "../AgentListItem/AgentListItem";

// Draggable project item moved to module scope to avoid remounting on every parent render.
// Defining components inside another component causes a new function identity each render,
// which forces React to unmount/remount the subtree. That led to hover flicker and high CPU.

/**
 * Compact button for opening Chat with Mux, showing an unread dot when there are
 * new messages since the user last viewed the workspace.
 */
const MuxChatHelpButton: React.FC<{
  onClick: () => void;
  isSelected: boolean;
}> = ({ onClick, isSelected }) => {
  const { isUnread: hasUnread } = useWorkspaceUnread(MUX_HELP_CHAT_WORKSPACE_ID);
  const isUnread = hasUnread && !isSelected;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className="text-muted hover:text-primary relative flex shrink-0 cursor-pointer items-center border-none bg-transparent p-0 transition-colors"
          aria-label="Open Chat with Mux"
        >
          <CircleHelp className="h-3.5 w-3.5" />
          {isUnread && (
            <span
              className="bg-accent absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full"
              aria-label="Unread messages"
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Chat with Mux</TooltipContent>
    </Tooltip>
  );
};

// Keep the project header visible while scrolling through long workspace lists.
// Project rows are also drag handles, so disable text selection to avoid
// highlighting the whole sidebar before a reorder gesture locks in.
const PROJECT_ITEM_BASE_CLASS =
  "sticky top-0 z-10 py-2 pl-2 pr-3 flex select-none items-center border-l-transparent bg-surface-primary transition-colors duration-150";

function getProjectItemClassName(opts: {
  isDragging: boolean;
  isOver: boolean;
  selected: boolean;
}): string {
  return cn(
    PROJECT_ITEM_BASE_CLASS,
    opts.isDragging ? "cursor-grabbing opacity-35 [&_*]:!cursor-grabbing" : "cursor-grab",
    opts.isOver && "bg-accent/[0.08]",
    opts.selected && "bg-hover border-l-accent",
    "hover:[&_button]:opacity-100 hover:[&_[data-drag-handle]]:opacity-100"
  );
}
type DraggableProjectItemProps = React.PropsWithChildren<{
  projectPath: string;
  onReorder: (draggedPath: string, targetPath: string) => void;
  selected?: boolean;
  onClick?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  role?: string;
  tabIndex?: number;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
  "aria-label"?: string;
  "data-project-path"?: string;
}>;

const DraggableProjectItemBase: React.FC<DraggableProjectItemProps> = ({
  projectPath,
  onReorder,
  children,
  selected,
  ...rest
}) => {
  const [{ isDragging }, drag, dragPreview] = useDrag(
    () => ({
      type: "PROJECT",
      item: { type: "PROJECT" as const, projectPath },
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [projectPath]
  );

  // Hide native drag preview; we render a custom preview via DragLayer
  useEffect(() => {
    dragPreview(getEmptyImage(), { captureDraggingState: true });
  }, [dragPreview]);

  const [{ isOver }, drop] = useDrop(
    () => ({
      accept: "PROJECT",
      drop: (item: { projectPath: string }) => {
        if (item.projectPath !== projectPath) {
          onReorder(item.projectPath, projectPath);
        }
      },
      collect: (monitor) => ({ isOver: monitor.isOver({ shallow: true }) }),
    }),
    [projectPath, onReorder]
  );

  return (
    <div
      ref={(node) => drag(drop(node))}
      className={getProjectItemClassName({
        isDragging,
        isOver,
        selected: !!selected,
      })}
      {...rest}
    >
      {children}
    </div>
  );
};

const DraggableProjectItem = React.memo(
  DraggableProjectItemBase,
  (prev, next) =>
    prev.projectPath === next.projectPath &&
    prev.onReorder === next.onReorder &&
    (prev["aria-expanded"] ?? false) === (next["aria-expanded"] ?? false)
);
/**
 * Wrapper that fetches draft data from localStorage and renders via unified AgentListItem.
 * Keeps data-fetching logic colocated with sidebar while delegating rendering to shared component.
 */
interface DraftAgentListItemWrapperProps {
  projectPath: string;
  draftId: string;
  draftNumber: number;
  isSelected: boolean;
  onOpen: () => void;
  onDelete: () => void;
}

// Debounce delay for sidebar preview updates during typing.
// Prevents constant re-renders while still providing timely feedback.
const DRAFT_PREVIEW_DEBOUNCE_MS = 1000;

function DraftAgentListItemWrapper(props: DraftAgentListItemWrapperProps) {
  const scopeId = getDraftScopeId(props.projectPath, props.draftId);

  const [draftPrompt] = usePersistedState<string>(getInputKey(scopeId), "", {
    listener: true,
  });

  const [workspaceNameState] = usePersistedState<unknown>(getWorkspaceNameStateKey(scopeId), null, {
    listener: true,
  });

  // Debounce the preview values to avoid constant sidebar updates while typing.
  const debouncedPrompt = useDebouncedValue(draftPrompt, DRAFT_PREVIEW_DEBOUNCE_MS);
  const debouncedNameState = useDebouncedValue(workspaceNameState, DRAFT_PREVIEW_DEBOUNCE_MS);

  const workspaceTitle = getDisplayTitleFromPersistedState(debouncedNameState);

  // Collapse whitespace so multi-line prompts show up nicely as a single-line preview.
  const promptPreview =
    typeof debouncedPrompt === "string" ? debouncedPrompt.trim().replace(/\s+/g, " ") : "";

  const titleText = workspaceTitle.trim().length > 0 ? workspaceTitle.trim() : "Draft";

  return (
    <AgentListItem
      variant="draft"
      projectPath={props.projectPath}
      isSelected={props.isSelected}
      draft={{
        draftId: props.draftId,
        draftNumber: props.draftNumber,
        title: titleText,
        promptPreview,
        onOpen: props.onOpen,
        onDelete: props.onDelete,
      }}
    />
  );
}

// Custom drag layer to show a semi-transparent preview and enforce grabbing cursor
interface ProjectDragItem {
  type: "PROJECT";
  projectPath: string;
}
interface SectionDragItemLocal {
  type: "SECTION_REORDER";
  sectionId: string;
  projectPath: string;
}
type DragItem = ProjectDragItem | SectionDragItemLocal | null;

const ProjectDragLayer: React.FC = () => {
  const dragState = useDragLayer<{
    isDragging: boolean;
    item: unknown;
    currentOffset: { x: number; y: number } | null;
  }>((monitor) => ({
    isDragging: monitor.isDragging(),
    item: monitor.getItem(),
    currentOffset: monitor.getClientOffset(),
  }));
  const isDragging = dragState.isDragging;
  const item = dragState.item as DragItem;
  const currentOffset = dragState.currentOffset;

  React.useEffect(() => {
    if (!isDragging) return;
    const originalBody = document.body.style.cursor;
    const originalHtml = document.documentElement.style.cursor;
    document.body.style.cursor = "grabbing";
    document.documentElement.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = originalBody;
      document.documentElement.style.cursor = originalHtml;
    };
  }, [isDragging]);

  // Only render for PROJECT type drags (not section reorder)
  if (!isDragging || !currentOffset || !item?.projectPath || item.type !== "PROJECT") return null;

  const abbrevPath = PlatformPaths.abbreviate(item.projectPath);
  const { basename } = PlatformPaths.splitAbbreviated(abbrevPath);

  return (
    <div className="pointer-events-none fixed inset-0 z-[9999] cursor-grabbing">
      <div style={{ transform: `translate(${currentOffset.x + 10}px, ${currentOffset.y + 10}px)` }}>
        <div className={cn(PROJECT_ITEM_BASE_CLASS, "w-fit max-w-64 rounded-sm shadow-lg")}>
          <span className="text-secondary mr-2 flex h-5 w-5 shrink-0 items-center justify-center">
            <ChevronRight size={12} />
          </span>
          <div className="flex min-w-0 flex-1 items-center pr-2">
            <span className="text-foreground truncate text-sm font-medium">{basename}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

function MuxChatStatusIndicator() {
  const fallbackModel = useWorkspaceFallbackModel(MUX_HELP_CHAT_WORKSPACE_ID);

  return (
    <WorkspaceStatusIndicator
      workspaceId={MUX_HELP_CHAT_WORKSPACE_ID}
      fallbackModel={fallbackModel}
      isCreating={false}
    />
  );
}

/**
 * Handles F2 (edit title) and Shift+F2 (generate new title) keybinds.
 * Rendered inside TitleEditProvider so it can access useTitleEdit().
 */
function SidebarTitleEditKeybinds(props: {
  selectedWorkspace: WorkspaceSelection | undefined;
  sortedWorkspacesByProject: Map<string, FrontendWorkspaceMetadata[]>;
  collapsed: boolean;
}) {
  const { requestEdit, wrapGenerateTitle } = useTitleEdit();
  const { api } = useAPI();

  const regenerateTitleForWorkspace = useCallback(
    (workspaceId: string) => {
      if (workspaceId === MUX_HELP_CHAT_WORKSPACE_ID) {
        return;
      }
      wrapGenerateTitle(workspaceId, () => {
        if (!api) {
          return Promise.resolve({ success: false, error: "Not connected to server" });
        }
        return api.workspace.regenerateTitle({ workspaceId });
      });
    },
    [wrapGenerateTitle, api]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (props.collapsed) return;
      if (!props.selectedWorkspace) return;
      if (isEditableElement(e.target)) return;
      const wsId = props.selectedWorkspace.workspaceId;
      if (wsId === MUX_HELP_CHAT_WORKSPACE_ID) return;

      if (matchesKeybind(e, KEYBINDS.EDIT_WORKSPACE_TITLE)) {
        e.preventDefault();
        const meta = props.sortedWorkspacesByProject
          .get(props.selectedWorkspace.projectPath)
          ?.find((m) => m.id === wsId);
        const displayTitle = meta?.title ?? meta?.name ?? "";
        requestEdit(wsId, displayTitle);
      } else if (matchesKeybind(e, KEYBINDS.GENERATE_WORKSPACE_TITLE)) {
        e.preventDefault();
        regenerateTitleForWorkspace(wsId);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    props.collapsed,
    props.selectedWorkspace,
    props.sortedWorkspacesByProject,
    requestEdit,
    regenerateTitleForWorkspace,
  ]);

  useEffect(() => {
    const handleGenerateTitleRequest: EventListener = (event) => {
      const customEvent = event as CustomEventType<
        typeof CUSTOM_EVENTS.WORKSPACE_GENERATE_TITLE_REQUESTED
      >;
      regenerateTitleForWorkspace(customEvent.detail.workspaceId);
    };

    window.addEventListener(
      CUSTOM_EVENTS.WORKSPACE_GENERATE_TITLE_REQUESTED,
      handleGenerateTitleRequest
    );
    return () => {
      window.removeEventListener(
        CUSTOM_EVENTS.WORKSPACE_GENERATE_TITLE_REQUESTED,
        handleGenerateTitleRequest
      );
    };
  }, [regenerateTitleForWorkspace]);

  return null;
}

interface ProjectSidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  sortedWorkspacesByProject: Map<string, FrontendWorkspaceMetadata[]>;
  workspaceRecency: Record<string, number>;
}

const ProjectSidebarInner: React.FC<ProjectSidebarProps> = ({
  collapsed,
  onToggleCollapsed,
  sortedWorkspacesByProject,
  workspaceRecency,
}) => {
  // Use the narrow actions context — does NOT subscribe to workspaceMetadata
  // changes, preventing the entire sidebar tree from re-rendering on every
  // workspace create/archive/rename.
  const {
    selectedWorkspace,
    setSelectedWorkspace: onSelectWorkspace,
    archiveWorkspace: onArchiveWorkspace,
    removeWorkspace,
    updateWorkspaceTitle: onUpdateTitle,
    refreshWorkspaceMetadata,
    pendingNewWorkspaceProject,
    pendingNewWorkspaceDraftId,
    workspaceDraftsByProject,
    workspaceDraftPromotionsByProject,
    createWorkspaceDraft,
    openWorkspaceDraft,
    deleteWorkspaceDraft,
  } = useWorkspaceActions();
  const workspaceStore = useWorkspaceStoreRaw();
  const runtimeStatusStore = useRuntimeStatusStoreRaw();
  const { navigateToProject } = useRouter();
  const { api } = useAPI();
  const { confirm: confirmDialog } = useConfirmDialog();
  const settings = useSettings();

  // Get project state and operations from context
  const {
    userProjects,
    openProjectCreateModal: onAddProject,
    removeProject: onRemoveProject,
    createSection,
    updateSection,
    removeSection,
    reorderSections,
    assignWorkspaceToSection,
  } = useProjectContext();

  // Theme for logo variant
  const { theme } = useTheme();
  const MuxLogo = theme === "dark" || theme.endsWith("-dark") ? MuxLogoDark : MuxLogoLight;
  const multiProjectWorkspacesEnabled = useExperimentValue(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES);

  // Mobile breakpoint for auto-closing sidebar
  const MOBILE_BREAKPOINT = 768;
  const projectListScrollRef = useRef<HTMLDivElement | null>(null);
  const mobileScrollTopRef = useRef(0);
  const wasCollapsedRef = useRef(collapsed);

  const normalizeMobileScrollTop = useCallback((scrollTop: number): number => {
    return Number.isFinite(scrollTop) ? Math.max(0, Math.round(scrollTop)) : 0;
  }, []);

  const persistMobileSidebarScrollTop = useCallback(
    (scrollTop: number) => {
      if (window.innerWidth > MOBILE_BREAKPOINT) {
        return;
      }

      // Keep the last viewed list position so reopening the touch sidebar returns
      // users to where they were browsing instead of jumping back to the top.
      const normalizedScrollTop = normalizeMobileScrollTop(scrollTop);
      updatePersistedState<number>(MOBILE_LEFT_SIDEBAR_SCROLL_TOP_KEY, normalizedScrollTop, 0);
    },
    [MOBILE_BREAKPOINT, normalizeMobileScrollTop]
  );

  useEffect(() => {
    if (collapsed || window.innerWidth > MOBILE_BREAKPOINT) {
      return;
    }

    const persistedScrollTop = readPersistedState<unknown>(MOBILE_LEFT_SIDEBAR_SCROLL_TOP_KEY, 0);
    const normalizedScrollTop =
      typeof persistedScrollTop === "number" ? normalizeMobileScrollTop(persistedScrollTop) : 0;
    mobileScrollTopRef.current = normalizedScrollTop;

    if (projectListScrollRef.current) {
      projectListScrollRef.current.scrollTop = normalizedScrollTop;
    }
  }, [collapsed, MOBILE_BREAKPOINT, normalizeMobileScrollTop]);

  useEffect(() => {
    const wasCollapsed = wasCollapsedRef.current;

    if (!wasCollapsed && collapsed) {
      persistMobileSidebarScrollTop(mobileScrollTopRef.current);
    }

    wasCollapsedRef.current = collapsed;
  }, [collapsed, persistMobileSidebarScrollTop]);

  const handleProjectListScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      mobileScrollTopRef.current = normalizeMobileScrollTop(event.currentTarget.scrollTop);
    },
    [normalizeMobileScrollTop]
  );

  // Wrapper to close sidebar on mobile after workspace selection
  const handleSelectWorkspace = useCallback(
    (selection: WorkspaceSelection) => {
      onSelectWorkspace(selection);
      if (window.innerWidth <= MOBILE_BREAKPOINT && !collapsed) {
        persistMobileSidebarScrollTop(mobileScrollTopRef.current);
        onToggleCollapsed();
      }
    },
    [onSelectWorkspace, collapsed, onToggleCollapsed, persistMobileSidebarScrollTop]
  );

  // Wrapper to close sidebar on mobile after adding workspace
  const handleAddWorkspace = useCallback(
    (projectPath: string, sectionId?: string) => {
      createWorkspaceDraft(projectPath, sectionId);
      if (window.innerWidth <= MOBILE_BREAKPOINT && !collapsed) {
        persistMobileSidebarScrollTop(mobileScrollTopRef.current);
        onToggleCollapsed();
      }
    },
    [createWorkspaceDraft, collapsed, onToggleCollapsed, persistMobileSidebarScrollTop]
  );

  // Wrapper to close sidebar on mobile after opening an existing draft
  const handleOpenWorkspaceDraft = useCallback(
    (projectPath: string, draftId: string, sectionId?: string | null) => {
      openWorkspaceDraft(projectPath, draftId, sectionId);
      if (window.innerWidth <= MOBILE_BREAKPOINT && !collapsed) {
        persistMobileSidebarScrollTop(mobileScrollTopRef.current);
        onToggleCollapsed();
      }
    },
    [openWorkspaceDraft, collapsed, onToggleCollapsed, persistMobileSidebarScrollTop]
  );

  const handleOpenMuxChat = useCallback(() => {
    // Read metadata imperatively from the store (no subscription) to avoid
    // making this callback depend on the metadata Map.
    const meta = workspaceStore.getWorkspaceMetadata(MUX_HELP_CHAT_WORKSPACE_ID);

    handleSelectWorkspace(
      meta
        ? {
            workspaceId: meta.id,
            projectPath: meta.projectPath,
            projectName: meta.projectName,
            namedWorkspacePath: meta.namedWorkspacePath,
          }
        : {
            // Fallback: navigate by ID; metadata will fill in once refreshed.
            workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
            projectPath: "",
            projectName: "Mux",
            namedWorkspacePath: "",
          }
    );

    if (!meta) {
      refreshWorkspaceMetadata().catch((error) => {
        console.error("Failed to refresh workspace metadata", error);
      });
    }
  }, [handleSelectWorkspace, refreshWorkspaceMetadata, workspaceStore]);

  const handleGoHome = useCallback(() => {
    // Selecting null delegates to WorkspaceContext's home-navigation + selection reset flow.
    onSelectWorkspace(null);
    // Close sidebar on mobile
    if (window.innerWidth <= MOBILE_BREAKPOINT && !collapsed) {
      persistMobileSidebarScrollTop(mobileScrollTopRef.current);
      onToggleCollapsed();
    }
  }, [onSelectWorkspace, collapsed, onToggleCollapsed, persistMobileSidebarScrollTop]);
  // Workspace-specific subscriptions moved to AgentListItem component

  // Store as array in localStorage, convert to Set for usage
  const [expandedProjectsArray, setExpandedProjectsArray] = usePersistedState<string[]>(
    EXPANDED_PROJECTS_KEY,
    []
  );
  // Handle corrupted localStorage data (old Set stored as {}).
  // Use a plain array with .includes() instead of new Set() on every render —
  // the React Compiler cannot stabilize Set allocations (see AGENTS.md).
  // For typical sidebar sizes (< 20 projects) .includes() is equivalent perf.
  const expandedProjectsList = Array.isArray(expandedProjectsArray) ? expandedProjectsArray : [];

  // Track which projects have old workspaces expanded (per-project, per-tier)
  // Key format: getTierKey(projectPath, tierIndex) where tierIndex is 0, 1, 2 for 1/7/30 days
  const [expandedOldWorkspaces, setExpandedOldWorkspaces] = usePersistedState<
    Record<string, boolean>
  >("expandedOldWorkspaces", {});

  // Track which sections are expanded
  const [expandedSections, setExpandedSections] = usePersistedState<Record<string, boolean>>(
    "expandedSections",
    {}
  );

  // Track parent workspaces whose reported child tasks are expanded.
  const [expandedCompletedSubAgents, setExpandedCompletedSubAgents] = usePersistedState<
    Record<string, boolean>
  >("expandedCompletedSubAgents", {});
  const toggleCompletedChildrenExpansion = useCallback(
    (workspaceId: string) => {
      setExpandedCompletedSubAgents((prev) => ({
        ...prev,
        [workspaceId]: !prev[workspaceId],
      }));
    },
    [setExpandedCompletedSubAgents]
  );
  const expandedCompletedParentIds = new Set(
    Object.entries(expandedCompletedSubAgents)
      .filter(([, expanded]) => expanded)
      .map(([workspaceId]) => workspaceId)
  );

  const [expandedBestOfGroups, setExpandedBestOfGroups] = useState<Record<string, boolean>>({});
  const toggleBestOfGroupExpansion = (groupId: string) => {
    setExpandedBestOfGroups((prev) => ({
      ...prev,
      [groupId]: !prev[groupId],
    }));
  };

  const [archivingWorkspaceIds, setArchivingWorkspaceIds] = useState<Set<string>>(new Set());
  const [removingWorkspaceIds, setRemovingWorkspaceIds] = useState<Set<string>>(new Set());
  const workspaceArchiveError = usePopoverError();
  const workspaceForkError = usePopoverError();
  const workspaceStopRuntimeError = usePopoverError();
  const workspaceRemoveError = usePopoverError();
  const [archiveConfirmation, setArchiveConfirmation] = useState<{
    workspaceId: string;
    displayTitle: string;
    buttonElement?: HTMLElement;
  } | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    projectPath: string;
    projectName: string;
    activeCount: number;
    archivedCount: number;
  } | null>(null);
  const projectRemoveError = usePopoverError();
  const sectionRemoveError = usePopoverError();

  const getProjectName = (path: string) => {
    if (!path || typeof path !== "string") {
      return "Unknown";
    }
    return PlatformPaths.getProjectName(path);
  };

  // Use functional update to avoid stale closure issues when clicking rapidly
  const toggleProject = useCallback(
    (projectPath: string) => {
      setExpandedProjectsArray((prev) => {
        const prevSet = new Set(Array.isArray(prev) ? prev : []);
        if (prevSet.has(projectPath)) {
          prevSet.delete(projectPath);
        } else {
          prevSet.add(projectPath);
        }
        return Array.from(prevSet);
      });
    },
    [setExpandedProjectsArray]
  );

  const toggleSection = (projectPath: string, sectionId: string) => {
    const key = getSectionExpandedKey(projectPath, sectionId);
    setExpandedSections((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleCreateSection = async (projectPath: string, name: string) => {
    const result = await createSection(projectPath, name);
    if (result.success) {
      // Auto-expand the new section
      const key = getSectionExpandedKey(projectPath, result.data.id);
      setExpandedSections((prev) => ({ ...prev, [key]: true }));
    }
  };

  const handleForkWorkspace = useCallback(
    async (workspaceId: string, buttonElement?: HTMLElement) => {
      if (!api) {
        workspaceForkError.showError(workspaceId, "Not connected to server");
        return;
      }

      let anchor: { top: number; left: number } | undefined;
      if (buttonElement) {
        const rect = buttonElement.getBoundingClientRect();
        anchor = {
          top: rect.top + window.scrollY,
          left: rect.right + 10,
        };
      }

      try {
        const result = await forkWorkspace({
          client: api,
          sourceWorkspaceId: workspaceId,
        });
        if (result.success) {
          return;
        }
        workspaceForkError.showError(workspaceId, result.error ?? "Failed to fork chat", anchor);
      } catch (error) {
        // IPC/transport failures throw instead of returning { success: false }
        const message = getErrorMessage(error);
        workspaceForkError.showError(workspaceId, message, anchor);
      }
    },
    [api, workspaceForkError]
  );

  const handleStopRuntime = useCallback(
    async (workspaceId: string, buttonElement?: HTMLElement) => {
      let anchor: { top: number; left: number } | undefined;
      if (buttonElement) {
        const rect = buttonElement.getBoundingClientRect();
        anchor = {
          top: rect.top + window.scrollY,
          left: rect.right + 10,
        };
      }

      if (!api) {
        workspaceStopRuntimeError.showError(workspaceId, "Not connected to server", anchor);
        return;
      }

      try {
        const result = await api.workspace.stopRuntime({ workspaceId });
        if (!result.success) {
          workspaceStopRuntimeError.showError(
            workspaceId,
            result.error ?? "Failed to stop container",
            anchor
          );
          return;
        }

        // A successful stop should hide the running indicator and menu action without
        // forcing rows to own their own optimistic runtime state.
        runtimeStatusStore.invalidateWorkspace(workspaceId);
      } catch (error) {
        workspaceStopRuntimeError.showError(workspaceId, getErrorMessage(error), anchor);
      }
    },
    [api, runtimeStatusStore, workspaceStopRuntimeError]
  );

  const performArchiveWorkspace = useCallback(
    async (workspaceId: string, buttonElement?: HTMLElement) => {
      // Mark workspace as being archived for UI feedback
      setArchivingWorkspaceIds((prev) => new Set(prev).add(workspaceId));

      try {
        const result = await onArchiveWorkspace(workspaceId);
        if (!result.success) {
          const error = result.error ?? "Failed to archive chat";
          let anchor: { top: number; left: number } | undefined;
          if (buttonElement) {
            const rect = buttonElement.getBoundingClientRect();
            anchor = {
              top: rect.top + window.scrollY,
              left: rect.right + 10,
            };
          }
          workspaceArchiveError.showError(workspaceId, error, anchor);
        }
      } finally {
        // Clear archiving state
        setArchivingWorkspaceIds((prev) => {
          const next = new Set(prev);
          next.delete(workspaceId);
          return next;
        });
      }
    },
    [onArchiveWorkspace, workspaceArchiveError]
  );

  const hasActiveStream = useCallback(
    (workspaceId: string) => {
      const aggregator = workspaceStore.getAggregator(workspaceId);
      if (!aggregator) return false;
      const hasActiveStreams = aggregator.getActiveStreams().length > 0;
      const isStarting = aggregator.getPendingStreamStartTime() !== null && !hasActiveStreams;
      const awaitingUserQuestion = aggregator.hasAwaitingUserQuestion();
      return (hasActiveStreams || isStarting) && !awaitingUserQuestion;
    },
    [workspaceStore]
  );

  const handleArchiveWorkspace = useCallback(
    async (workspaceId: string, buttonElement?: HTMLElement) => {
      if (hasActiveStream(workspaceId)) {
        // Read metadata imperatively (no subscription) to build the display title.
        const metadata = workspaceStore.getWorkspaceMetadata(workspaceId);
        const displayTitle = metadata?.title ?? metadata?.name ?? workspaceId;
        // Confirm before archiving if a stream is active so users don't interrupt in-progress work.
        setArchiveConfirmation({ workspaceId, displayTitle, buttonElement });
        return;
      }

      await performArchiveWorkspace(workspaceId, buttonElement);
    },
    [hasActiveStream, performArchiveWorkspace, workspaceStore]
  );

  const handleArchiveWorkspaceConfirm = useCallback(async () => {
    if (!archiveConfirmation) {
      return;
    }

    try {
      await performArchiveWorkspace(
        archiveConfirmation.workspaceId,
        archiveConfirmation.buttonElement
      );
    } finally {
      setArchiveConfirmation(null);
    }
  }, [archiveConfirmation, performArchiveWorkspace]);

  const handleArchiveWorkspaceCancel = useCallback(() => {
    setArchiveConfirmation(null);
  }, []);

  const showProjectRemoveError = useCallback(
    (
      projectPath: string,
      error: {
        type: string;
        message?: string;
        activeCount?: number;
        archivedCount?: number;
      },
      buttonElement?: HTMLElement
    ) => {
      let message: string;
      if (error.type === "workspace_blockers") {
        const parts: string[] = [];
        const activeCount = error.activeCount ?? 0;
        const archivedCount = error.archivedCount ?? 0;

        if (activeCount > 0) {
          parts.push(`${activeCount} active`);
        }
        if (archivedCount > 0) {
          parts.push(`${archivedCount} archived`);
        }
        message = `Has ${parts.join(" and ")} workspace(s)`;
      } else if (error.type === "project_not_found") {
        message = "Project not found";
      } else {
        message = error.message ?? "Failed to remove project";
      }

      let anchor: { top: number; left: number } | undefined;
      if (buttonElement) {
        const rect = buttonElement.getBoundingClientRect();
        anchor = {
          top: rect.top + window.scrollY,
          left: rect.right + 10,
        };
      }

      projectRemoveError.showError(projectPath, message, anchor);
    },
    [projectRemoveError]
  );

  const removeProjectWithFeedback = useCallback(
    async (projectPath: string, options?: { force?: boolean }, buttonElement?: HTMLElement) => {
      const result = await onRemoveProject(projectPath, options);
      if (!result.success) {
        showProjectRemoveError(projectPath, result.error, buttonElement);
      }
      return result;
    },
    [onRemoveProject, showProjectRemoveError]
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirmation) {
      return;
    }

    const result = await removeProjectWithFeedback(deleteConfirmation.projectPath, {
      force: true,
    });
    if (result.success) {
      setDeleteConfirmation(null);
    }
  }, [deleteConfirmation, removeProjectWithFeedback]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteConfirmation(null);
  }, []);
  const handleCancelWorkspaceCreation = useCallback(
    async (workspaceId: string) => {
      // Give immediate UI feedback (spinner / disabled row) while deletion is in-flight.
      setRemovingWorkspaceIds((prev) => new Set(prev).add(workspaceId));

      try {
        const result = await removeWorkspace(workspaceId, { force: true });
        if (!result.success) {
          workspaceRemoveError.showError(
            workspaceId,
            result.error ?? "Failed to cancel workspace creation"
          );
        }
      } finally {
        setRemovingWorkspaceIds((prev) => {
          const next = new Set(prev);
          next.delete(workspaceId);
          return next;
        });
      }
    },
    [removeWorkspace, workspaceRemoveError]
  );

  const handleRemoveSection = async (
    projectPath: string,
    sectionId: string,
    buttonElement: HTMLElement
  ) => {
    // removeSection unsections every workspace in the project (including archived),
    // so confirmation needs to count from the full project config.
    const workspacesInSection = (userProjects.get(projectPath)?.workspaces ?? []).filter(
      (workspace) => workspace.sectionId === sectionId
    );

    if (workspacesInSection.length > 0) {
      const ok = await confirmDialog({
        title: "Delete section?",
        description: `${workspacesInSection.length} workspace(s) in this section will be moved to unsectioned.`,
        confirmLabel: "Delete",
        confirmVariant: "destructive",
      });
      if (!ok) {
        return;
      }
    }

    const result = await removeSection(projectPath, sectionId);
    if (!result.success) {
      const error = result.error ?? "Failed to remove section";
      const rect = buttonElement.getBoundingClientRect();
      const anchor = {
        top: rect.top + window.scrollY,
        left: rect.right + 10,
      };
      sectionRemoveError.showError(sectionId, error, anchor);
    }
  };

  const handleOpenSecrets = (projectPath: string) => {
    // Collapse the off-canvas sidebar on mobile before navigating so the
    // settings page is immediately accessible without a backdrop blocking it.
    if (window.innerWidth <= MOBILE_BREAKPOINT && !collapsed) {
      persistMobileSidebarScrollTop(mobileScrollTopRef.current);
      onToggleCollapsed();
    }
    // Navigate to Settings → Secrets with the project pre-selected.
    settings.open("secrets", { secretsProjectPath: projectPath });
  };

  // UI preference: project order persists in localStorage
  const [projectOrder, setProjectOrder] = usePersistedState<string[]>("mux:projectOrder", []);

  // Build a stable signature of the project keys so effects don't fire on Map identity churn
  const projectPathsSignature = React.useMemo(() => {
    // sort to avoid order-related churn
    const keys = Array.from(userProjects.keys()).sort();
    return keys.join("\u0001"); // use non-printable separator
  }, [userProjects]);

  // Normalize order when the set of projects changes (not on every parent render)
  useEffect(() => {
    // Skip normalization if projects haven't loaded yet (empty Map on initial render)
    // This prevents clearing projectOrder before projects load from backend
    if (userProjects.size === 0) {
      return;
    }

    const normalized = normalizeOrder(projectOrder, userProjects);
    if (
      normalized.length !== projectOrder.length ||
      normalized.some((p, i) => p !== projectOrder[i])
    ) {
      setProjectOrder(normalized);
    }
    // Only re-run when project keys change (projectPathsSignature captures projects Map keys)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPathsSignature]);

  // Memoize sorted project PATHS (not entries) to avoid capturing stale config objects.
  // Sorting depends only on keys + order; we read configs from the live Map during render.
  const sortedProjectPaths = React.useMemo(
    () => sortProjectsByOrder(userProjects, projectOrder).map(([p]) => p),
    // projectPathsSignature captures projects Map keys
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectPathsSignature, projectOrder]
  );

  const singleProjectWorkspacesByProject = new Map<string, FrontendWorkspaceMetadata[]>();
  const multiProjectWorkspacesById = new Map<string, FrontendWorkspaceMetadata>();

  for (const [projectPath, workspaces] of sortedWorkspacesByProject) {
    const singleProjectWorkspaces: FrontendWorkspaceMetadata[] = [];
    for (const workspace of workspaces) {
      if (isMultiProject(workspace)) {
        if (multiProjectWorkspacesEnabled) {
          multiProjectWorkspacesById.set(workspace.id, workspace);
        }
        continue;
      }

      singleProjectWorkspaces.push(workspace);
    }
    singleProjectWorkspacesByProject.set(projectPath, singleProjectWorkspaces);
  }

  const multiProjectWorkspaces = Array.from(multiProjectWorkspacesById.values());
  // Multi-project rows should share the same completed-subagent chevron behavior as
  // regular workspace rows, so reuse the same visibility + metadata calculations.
  const multiProjectDepthByWorkspaceId = computeWorkspaceDepthMap(multiProjectWorkspaces);
  const visibleMultiProjectWorkspaces = filterVisibleAgentRows(
    multiProjectWorkspaces,
    expandedCompletedParentIds
  );
  const multiProjectRowMetaByWorkspaceId = computeAgentRowRenderMeta(
    multiProjectWorkspaces,
    multiProjectDepthByWorkspaceId,
    expandedCompletedParentIds
  );
  const isMultiProjectSectionExpanded = expandedProjectsList.includes(
    MULTI_PROJECT_SIDEBAR_SECTION_ID
  );

  const handleReorder = useCallback(
    (draggedPath: string, targetPath: string) => {
      const next = reorderProjects(projectOrder, userProjects, draggedPath, targetPath);
      setProjectOrder(next);
    },
    [projectOrder, userProjects, setProjectOrder]
  );

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Create new workspace for the project of the selected workspace
      if (matchesKeybind(e, KEYBINDS.NEW_WORKSPACE) && selectedWorkspace) {
        e.preventDefault();
        if (selectedWorkspace.workspaceId === MUX_HELP_CHAT_WORKSPACE_ID) {
          return;
        }
        handleAddWorkspace(selectedWorkspace.projectPath);
      } else if (matchesKeybind(e, KEYBINDS.ARCHIVE_WORKSPACE) && selectedWorkspace) {
        e.preventDefault();
        void handleArchiveWorkspace(selectedWorkspace.workspaceId);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedWorkspace, handleAddWorkspace, handleArchiveWorkspace]);

  // Chat-with-Mux workspace registration is async at startup. Avoid mounting
  // mux-chat header widgets until metadata exists so their hooks don't assert.
  const muxChatWorkspaceExists =
    workspaceStore.getWorkspaceMetadata(MUX_HELP_CHAT_WORKSPACE_ID) !== undefined;

  return (
    <TitleEditProvider onUpdateTitle={onUpdateTitle}>
      <SidebarTitleEditKeybinds
        selectedWorkspace={selectedWorkspace ?? undefined}
        sortedWorkspacesByProject={sortedWorkspacesByProject}
        collapsed={collapsed}
      />
      <DndProvider backend={HTML5Backend}>
        <ProjectDragLayer />
        <WorkspaceDragLayer />
        <SectionDragLayer />
        <div
          className={cn(
            // The sidebar doubles as a drag surface, so keep copy selection disabled
            // unless a child input explicitly opts back into text selection.
            "font-primary bg-surface-primary border-border-light flex flex-1 select-none flex-col overflow-hidden border-r",
            // In desktop mode when collapsed, hide border (LeftSidebar handles the partial border)
            isDesktopMode() && collapsed && "border-r-0"
          )}
          role="navigation"
          aria-label="Projects"
        >
          {!collapsed && (
            <>
              <div className="border-dark flex items-center justify-between border-b py-3 pr-3 pl-4">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    onClick={handleGoHome}
                    className="shrink-0 cursor-pointer border-none bg-transparent p-0"
                    aria-label="Home"
                  >
                    <MuxLogo className="h-5 w-[44px]" aria-hidden="true" />
                  </button>
                  {muxChatWorkspaceExists && (
                    <>
                      <MuxChatHelpButton
                        onClick={handleOpenMuxChat}
                        isSelected={selectedWorkspace?.workspaceId === MUX_HELP_CHAT_WORKSPACE_ID}
                      />
                      <MuxChatStatusIndicator />
                    </>
                  )}
                </div>
                <button
                  onClick={onAddProject}
                  aria-label="Add project"
                  className="text-secondary hover:bg-hover hover:border-border-light flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded border border-transparent bg-transparent px-1.5 text-xs transition-all duration-200"
                >
                  <span className="text-base leading-none">+</span>
                  <span>Add Project</span>
                </button>
              </div>
              <div
                ref={projectListScrollRef}
                onScroll={handleProjectListScroll}
                className="flex-1 overflow-x-hidden overflow-y-auto"
              >
                {multiProjectWorkspaces.length > 0 && (
                  <div className="border-hover border-b">
                    <div className={PROJECT_ITEM_BASE_CLASS}>
                      <button
                        onClick={() => toggleProject(MULTI_PROJECT_SIDEBAR_SECTION_ID)}
                        aria-label={`${isMultiProjectSectionExpanded ? "Collapse" : "Expand"} multi-project workspaces`}
                        className="text-secondary hover:bg-hover hover:border-border-light mr-1.5 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-transparent bg-transparent p-0 transition-all duration-200"
                      >
                        <ChevronRight
                          size={12}
                          className="transition-transform duration-200"
                          style={{
                            transform: isMultiProjectSectionExpanded
                              ? "rotate(90deg)"
                              : "rotate(0deg)",
                          }}
                        />
                      </button>
                      <div className="flex min-w-0 flex-1 items-center pr-2">
                        <span className="text-foreground truncate text-sm font-medium">
                          Multi-Project
                        </span>
                        <span className="text-muted ml-2 text-xs">
                          ({multiProjectWorkspaces.length})
                        </span>
                      </div>
                    </div>
                    {isMultiProjectSectionExpanded && (
                      <div className="pt-1 pb-1">
                        {visibleMultiProjectWorkspaces.map((metadata) => {
                          const rowRenderMeta = multiProjectRowMetaByWorkspaceId.get(metadata.id);

                          return (
                            <AgentListItem
                              key={metadata.id}
                              metadata={metadata}
                              projectPath={metadata.projectPath}
                              projectName={metadata.projectName}
                              isSelected={selectedWorkspace?.workspaceId === metadata.id}
                              isArchiving={archivingWorkspaceIds.has(metadata.id)}
                              isRemoving={
                                removingWorkspaceIds.has(metadata.id) ||
                                metadata.isRemoving === true
                              }
                              onSelectWorkspace={handleSelectWorkspace}
                              onForkWorkspace={handleForkWorkspace}
                              onArchiveWorkspace={handleArchiveWorkspace}
                              onCancelCreation={handleCancelWorkspaceCreation}
                              depth={
                                rowRenderMeta?.depth ??
                                multiProjectDepthByWorkspaceId[metadata.id] ??
                                0
                              }
                              rowRenderMeta={rowRenderMeta}
                              completedChildrenExpanded={
                                expandedCompletedSubAgents[metadata.id] ?? false
                              }
                              onToggleCompletedChildren={toggleCompletedChildrenExpansion}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {sortedProjectPaths.length === 0 && multiProjectWorkspaces.length === 0 ? (
                  <div className="px-4 py-8 text-center">
                    <p className="text-muted mb-4 text-[13px]">No projects</p>
                    <button
                      onClick={onAddProject}
                      className="bg-accent hover:bg-accent-dark cursor-pointer rounded border-none px-4 py-2 text-[13px] text-white transition-colors duration-200"
                    >
                      Add Project
                    </button>
                  </div>
                ) : (
                  sortedProjectPaths.map((projectPath) => {
                    const config = userProjects.get(projectPath);
                    if (!config) return null;
                    const projectName = getProjectName(projectPath);
                    const sanitizedProjectId =
                      projectPath.replace(/[^a-zA-Z0-9_-]/g, "-") || "root";
                    const workspaceListId = `workspace-list-${sanitizedProjectId}`;
                    const isExpanded = expandedProjectsList.includes(projectPath);
                    const counts = getProjectWorkspaceCounts(config.workspaces);
                    const removeTooltip = "Remove project";

                    return (
                      <div key={projectPath} className="border-hover border-b">
                        <DraggableProjectItem
                          projectPath={projectPath}
                          onReorder={handleReorder}
                          selected={false}
                          onClick={() => handleAddWorkspace(projectPath)}
                          onKeyDown={(e: React.KeyboardEvent) => {
                            // Ignore key events from child buttons
                            if (e.target instanceof HTMLElement && e.target !== e.currentTarget) {
                              return;
                            }
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleAddWorkspace(projectPath);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          aria-expanded={isExpanded}
                          aria-controls={workspaceListId}
                          aria-label={`Create workspace in ${projectName}`}
                          data-project-path={projectPath}
                        >
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleProject(projectPath);
                            }}
                            aria-label={`${isExpanded ? "Collapse" : "Expand"} project ${projectName}`}
                            data-project-path={projectPath}
                            className="text-secondary hover:bg-hover hover:border-border-light mr-1.5 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-transparent bg-transparent p-0 transition-all duration-200"
                          >
                            <ChevronRight
                              size={12}
                              className="transition-transform duration-200"
                              style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
                            />
                          </button>
                          <div className="flex min-w-0 flex-1 items-center pr-2">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="text-muted-dark flex gap-2 truncate text-sm">
                                  {(() => {
                                    const abbrevPath = PlatformPaths.abbreviate(projectPath);
                                    const { basename } = PlatformPaths.splitAbbreviated(abbrevPath);
                                    return (
                                      <span className="text-foreground truncate font-medium">
                                        {basename}
                                      </span>
                                    );
                                  })()}
                                </div>
                              </TooltipTrigger>
                              <TooltipContent align="start">{projectPath}</TooltipContent>
                            </Tooltip>
                          </div>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleOpenSecrets(projectPath);
                                }}
                                aria-label={`Manage secrets for ${projectName}`}
                                data-project-path={projectPath}
                                className="text-muted-dark mr-1 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent text-sm opacity-0 transition-all duration-200 hover:bg-yellow-500/10 hover:text-yellow-500 [@media(max-width:768px)_and_(hover:none)_and_(pointer:coarse)]:hidden [@media(min-width:769px)_and_(hover:none)_and_(pointer:coarse)]:opacity-100"
                              >
                                <KeyRound size={12} />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent align="end">Manage secrets</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const buttonElement = event.currentTarget;
                                  const total = counts.activeCount + counts.archivedCount;
                                  if (total > 0) {
                                    setDeleteConfirmation({
                                      projectPath,
                                      projectName,
                                      activeCount: counts.activeCount,
                                      archivedCount: counts.archivedCount,
                                    });
                                    return;
                                  }

                                  void removeProjectWithFeedback(
                                    projectPath,
                                    undefined,
                                    buttonElement
                                  );
                                }}
                                aria-label={`Remove project ${projectName}`}
                                data-project-path={projectPath}
                                className={cn(
                                  "text-muted-dark mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] border-none bg-transparent text-base opacity-0 transition-all duration-200",
                                  "[@media(max-width:768px)_and_(hover:none)_and_(pointer:coarse)]:hidden",
                                  "[@media(min-width:769px)_and_(hover:none)_and_(pointer:coarse)]:opacity-100",
                                  "cursor-pointer hover:bg-danger-light/10 hover:text-danger-light"
                                )}
                              >
                                ×
                              </button>
                            </TooltipTrigger>
                            <TooltipContent align="end">{removeTooltip}</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleAddWorkspace(projectPath);
                                }}
                                aria-label={`New chat in ${projectName}`}
                                data-project-path={projectPath}
                                className="text-secondary hover:bg-hover hover:border-border-light flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-transparent bg-transparent text-sm leading-none transition-all duration-200"
                              >
                                +
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>
                              New chat ({formatKeybind(KEYBINDS.NEW_WORKSPACE)})
                            </TooltipContent>
                          </Tooltip>
                        </DraggableProjectItem>

                        {isExpanded && (
                          <div
                            id={workspaceListId}
                            role="region"
                            aria-label={`Workspaces for ${projectName}`}
                            className="pt-1"
                          >
                            {(() => {
                              // Archived workspaces are excluded from workspaceMetadata so won't appear here

                              const allWorkspaces =
                                singleProjectWorkspacesByProject.get(projectPath) ?? [];

                              const draftsForProject = workspaceDraftsByProject[projectPath] ?? [];
                              const activeDraftIds = new Set(
                                draftsForProject.map((draft) => draft.draftId)
                              );
                              const draftPromotionsForProject =
                                workspaceDraftPromotionsByProject[projectPath] ?? {};
                              const activeDraftPromotions = Object.fromEntries(
                                Object.entries(draftPromotionsForProject).filter(([draftId]) =>
                                  activeDraftIds.has(draftId)
                                )
                              );
                              const promotedWorkspaceIds = new Set(
                                Object.values(activeDraftPromotions).map((metadata) => metadata.id)
                              );
                              const workspacesForNormalRendering = allWorkspaces.filter(
                                (workspace) => !promotedWorkspaceIds.has(workspace.id)
                              );
                              const sections = sortSectionsByLinkedList(config.sections ?? []);
                              const depthByWorkspaceId = computeWorkspaceDepthMap(allWorkspaces);
                              const visibleWorkspacesForNormalRendering = filterVisibleAgentRows(
                                workspacesForNormalRendering,
                                expandedCompletedParentIds
                              );
                              const baseRowMetaByWorkspaceId = computeAgentRowRenderMeta(
                                workspacesForNormalRendering,
                                depthByWorkspaceId,
                                expandedCompletedParentIds
                              );
                              const sortedDrafts = draftsForProject
                                .slice()
                                .sort((a, b) => b.createdAt - a.createdAt);
                              const draftNumberById = new Map(
                                sortedDrafts.map(
                                  (draft, index) => [draft.draftId, index + 1] as const
                                )
                              );
                              const sectionIds = new Set(sections.map((section) => section.id));
                              const normalizeDraftSectionId = (
                                draft: (typeof sortedDrafts)[number]
                              ): string | null => {
                                return typeof draft.sectionId === "string" &&
                                  sectionIds.has(draft.sectionId)
                                  ? draft.sectionId
                                  : null;
                              };

                              // Drafts can reference a section that has since been deleted.
                              // Treat those as unsectioned so they remain accessible.
                              const unsectionedDrafts: typeof sortedDrafts = [];
                              const draftsBySectionId = new Map<string, typeof sortedDrafts>();
                              for (const draft of sortedDrafts) {
                                const sectionId = normalizeDraftSectionId(draft);
                                if (sectionId === null) {
                                  unsectionedDrafts.push(draft);
                                  continue;
                                }

                                const existing = draftsBySectionId.get(sectionId);
                                if (existing) {
                                  existing.push(draft);
                                } else {
                                  draftsBySectionId.set(sectionId, [draft]);
                                }
                              }

                              const renderWorkspace = (
                                metadata: FrontendWorkspaceMetadata,
                                sectionId?: string,
                                rowRenderMetaOverride?: AgentRowRenderMeta | null,
                                depthOverride?: number,
                                keyOverride?: string
                              ) => {
                                const rowRenderMeta =
                                  rowRenderMetaOverride === undefined
                                    ? baseRowMetaByWorkspaceId.get(metadata.id)
                                    : (rowRenderMetaOverride ?? undefined);

                                return (
                                  <AgentListItem
                                    key={keyOverride ?? metadata.id}
                                    metadata={metadata}
                                    projectPath={projectPath}
                                    projectName={projectName}
                                    isSelected={selectedWorkspace?.workspaceId === metadata.id}
                                    isArchiving={archivingWorkspaceIds.has(metadata.id)}
                                    isRemoving={
                                      removingWorkspaceIds.has(metadata.id) ||
                                      metadata.isRemoving === true
                                    }
                                    onSelectWorkspace={handleSelectWorkspace}
                                    onForkWorkspace={handleForkWorkspace}
                                    onStopRuntime={handleStopRuntime}
                                    onArchiveWorkspace={handleArchiveWorkspace}
                                    onCancelCreation={handleCancelWorkspaceCreation}
                                    depth={
                                      depthOverride ??
                                      rowRenderMeta?.depth ??
                                      depthByWorkspaceId[metadata.id] ??
                                      0
                                    }
                                    sectionId={sectionId}
                                    rowRenderMeta={rowRenderMeta}
                                    completedChildrenExpanded={
                                      expandedCompletedSubAgents[metadata.id] ?? false
                                    }
                                    onToggleCompletedChildren={toggleCompletedChildrenExpansion}
                                  />
                                );
                              };

                              const renderWorkspaceRowsWithBestOfCoalescing = ({
                                rows,
                                allRows,
                                sectionId,
                                rowMetaByWorkspaceId,
                              }: {
                                rows: FrontendWorkspaceMetadata[];
                                allRows: FrontendWorkspaceMetadata[];
                                sectionId?: string;
                                rowMetaByWorkspaceId: ReadonlyMap<string, AgentRowRenderMeta>;
                              }): React.ReactNode[] => {
                                if (rows.length === 0) {
                                  return [];
                                }

                                const childrenByParentId = new Map<
                                  string,
                                  FrontendWorkspaceMetadata[]
                                >();
                                for (const workspace of allRows) {
                                  const parentId = workspace.parentWorkspaceId;
                                  if (!parentId) {
                                    continue;
                                  }
                                  const children = childrenByParentId.get(parentId) ?? [];
                                  children.push(workspace);
                                  childrenByParentId.set(parentId, children);
                                }

                                const getBestOfGroupId = (
                                  workspace: FrontendWorkspaceMetadata
                                ): string | null => {
                                  const groupId = workspace.bestOf?.groupId;
                                  if (!groupId || !workspace.parentWorkspaceId) {
                                    return null;
                                  }
                                  if ((workspace.bestOf?.total ?? 1) < 2) {
                                    return null;
                                  }
                                  const hasChildren = childrenByParentId.has(workspace.id);
                                  return hasChildren ? null : groupId;
                                };

                                const allMembersByGroupId = new Map<
                                  string,
                                  FrontendWorkspaceMetadata[]
                                >();
                                for (const workspace of allRows) {
                                  const groupId = getBestOfGroupId(workspace);
                                  if (!groupId) {
                                    continue;
                                  }
                                  const group = allMembersByGroupId.get(groupId) ?? [];
                                  group.push(workspace);
                                  allMembersByGroupId.set(groupId, group);
                                }

                                const visibleMembersByGroupId = new Map<
                                  string,
                                  FrontendWorkspaceMetadata[]
                                >();
                                for (const workspace of rows) {
                                  const groupId = getBestOfGroupId(workspace);
                                  if (!groupId) {
                                    continue;
                                  }
                                  const group = visibleMembersByGroupId.get(groupId) ?? [];
                                  group.push(workspace);
                                  visibleMembersByGroupId.set(groupId, group);
                                }

                                const indexByWorkspaceId = new Map(
                                  rows.map((workspace, index) => [workspace.id, index] as const)
                                );
                                const validGroupIds = new Set<string>();
                                for (const [groupId, visibleMembers] of visibleMembersByGroupId) {
                                  const allMembers = allMembersByGroupId.get(groupId) ?? [];
                                  if (visibleMembers.length < 2 || allMembers.length < 2) {
                                    continue;
                                  }
                                  const indices = visibleMembers
                                    .map((workspace) => indexByWorkspaceId.get(workspace.id))
                                    .filter((index): index is number => index != null);
                                  if (indices.length !== visibleMembers.length) {
                                    continue;
                                  }
                                  const firstIndex = Math.min(...indices);
                                  const lastIndex = Math.max(...indices);
                                  if (lastIndex - firstIndex + 1 !== visibleMembers.length) {
                                    continue;
                                  }
                                  validGroupIds.add(groupId);
                                }

                                const skippedWorkspaceIds = new Set<string>();
                                const renderedRows: React.ReactNode[] = [];

                                for (const workspace of rows) {
                                  if (skippedWorkspaceIds.has(workspace.id)) {
                                    continue;
                                  }

                                  const bestOfGroupId = getBestOfGroupId(workspace);
                                  if (!bestOfGroupId || !validGroupIds.has(bestOfGroupId)) {
                                    renderedRows.push(
                                      renderWorkspace(
                                        workspace,
                                        sectionId,
                                        rowMetaByWorkspaceId.get(workspace.id)
                                      )
                                    );
                                    continue;
                                  }

                                  const visibleMembers =
                                    visibleMembersByGroupId.get(bestOfGroupId) ?? [];
                                  if (visibleMembers[0]?.id !== workspace.id) {
                                    continue;
                                  }

                                  for (const member of visibleMembers) {
                                    skippedWorkspaceIds.add(member.id);
                                  }

                                  const allMembers =
                                    allMembersByGroupId.get(bestOfGroupId) ?? visibleMembers;
                                  const depth =
                                    rowMetaByWorkspaceId.get(workspace.id)?.depth ??
                                    depthByWorkspaceId[workspace.id] ??
                                    0;
                                  const totalCount = Math.max(
                                    allMembers[0]?.bestOf?.total ?? allMembers.length,
                                    allMembers.length
                                  );
                                  let completedCount = 0;
                                  let runningCount = 0;
                                  let queuedCount = 0;
                                  let interruptedCount = 0;
                                  for (const member of allMembers) {
                                    const hasCompletedReport = hasCompletedAgentReport(member);
                                    if (hasCompletedReport) {
                                      completedCount += 1;
                                      continue;
                                    }
                                    if (
                                      member.taskStatus === "running" ||
                                      member.taskStatus === "awaiting_report"
                                    ) {
                                      runningCount += 1;
                                      continue;
                                    }
                                    if (member.taskStatus === "queued") {
                                      queuedCount += 1;
                                      continue;
                                    }
                                    if (member.taskStatus === "interrupted") {
                                      interruptedCount += 1;
                                    }
                                  }
                                  const groupTitle =
                                    allMembers[0]?.title ?? allMembers[0]?.name ?? "Task group";
                                  const isExpanded = expandedBestOfGroups[bestOfGroupId] ?? false;

                                  renderedRows.push(
                                    <BestOfGroupListItem
                                      key={`best-of-group:${bestOfGroupId}`}
                                      groupId={bestOfGroupId}
                                      title={groupTitle}
                                      depth={depth}
                                      totalCount={totalCount}
                                      visibleCount={visibleMembers.length}
                                      completedCount={completedCount}
                                      runningCount={runningCount}
                                      queuedCount={queuedCount}
                                      interruptedCount={interruptedCount}
                                      isExpanded={isExpanded}
                                      isSelected={allMembers.some(
                                        (member) => member.id === selectedWorkspace?.workspaceId
                                      )}
                                      onToggle={() => {
                                        toggleBestOfGroupExpansion(bestOfGroupId);
                                      }}
                                    />
                                  );

                                  if (isExpanded) {
                                    for (const member of visibleMembers) {
                                      renderedRows.push(
                                        renderWorkspace(
                                          member,
                                          sectionId,
                                          null,
                                          depth + 1,
                                          `best-of-member:${bestOfGroupId}:${member.id}`
                                        )
                                      );
                                    }
                                  }
                                }

                                return renderedRows;
                              };

                              const renderDraft = (
                                draft: (typeof sortedDrafts)[number]
                              ): React.ReactNode => {
                                const sectionId = normalizeDraftSectionId(draft);
                                const promotedMetadata = activeDraftPromotions[draft.draftId];

                                if (promotedMetadata) {
                                  const liveMetadata =
                                    allWorkspaces.find(
                                      (workspace) => workspace.id === promotedMetadata.id
                                    ) ?? promotedMetadata;
                                  return renderWorkspace(liveMetadata, sectionId ?? undefined);
                                }

                                const draftNumber = draftNumberById.get(draft.draftId) ?? 0;
                                const isSelected =
                                  pendingNewWorkspaceProject === projectPath &&
                                  pendingNewWorkspaceDraftId === draft.draftId;

                                return (
                                  <DraftAgentListItemWrapper
                                    key={draft.draftId}
                                    projectPath={projectPath}
                                    draftId={draft.draftId}
                                    draftNumber={draftNumber}
                                    isSelected={isSelected}
                                    onOpen={() =>
                                      handleOpenWorkspaceDraft(
                                        projectPath,
                                        draft.draftId,
                                        sectionId
                                      )
                                    }
                                    onDelete={() => {
                                      if (isSelected) {
                                        const currentIndex = sortedDrafts.findIndex(
                                          (d) => d.draftId === draft.draftId
                                        );
                                        const fallback =
                                          currentIndex >= 0
                                            ? (sortedDrafts[currentIndex + 1] ??
                                              sortedDrafts[currentIndex - 1])
                                            : undefined;

                                        if (fallback) {
                                          openWorkspaceDraft(
                                            projectPath,
                                            fallback.draftId,
                                            normalizeDraftSectionId(fallback)
                                          );
                                        } else {
                                          navigateToProject(projectPath, sectionId ?? undefined);
                                        }
                                      }

                                      deleteWorkspaceDraft(projectPath, draft.draftId);
                                    }}
                                  />
                                );
                              };

                              // Render age tiers for a list of workspaces
                              const renderAgeTiers = (
                                workspaces: FrontendWorkspaceMetadata[],
                                tierKeyPrefix: string,
                                sectionId?: string,
                                allRowsForBestOfCoalescing: FrontendWorkspaceMetadata[] = workspaces
                              ): React.ReactNode => {
                                const { recent: topVisibleRows, buckets } =
                                  partitionWorkspacesByAge(workspaces, workspaceRecency);

                                const expandedTierVisibleIds = new Set<string>();
                                const markExpandedTierRowsVisible = (tierIndex: number): void => {
                                  const bucket = buckets[tierIndex];
                                  const remainingCount = buckets
                                    .slice(tierIndex)
                                    .reduce((sum, bucketRows) => sum + bucketRows.length, 0);
                                  if (remainingCount === 0) {
                                    return;
                                  }

                                  const tierKey = `${tierKeyPrefix}:${tierIndex}`;
                                  const isTierExpanded = expandedOldWorkspaces[tierKey] ?? false;
                                  if (!isTierExpanded) {
                                    return;
                                  }

                                  for (const workspace of bucket) {
                                    expandedTierVisibleIds.add(workspace.id);
                                  }

                                  const nextTier = findNextNonEmptyTier(buckets, tierIndex + 1);
                                  if (nextTier !== -1) {
                                    markExpandedTierRowsVisible(nextTier);
                                  }
                                };

                                const firstTier = findNextNonEmptyTier(buckets, 0);
                                if (firstTier !== -1) {
                                  markExpandedTierRowsVisible(firstTier);
                                }

                                // Connector geometry should match the rows users can currently see,
                                // not hidden siblings parked behind collapsed age tiers.
                                const visibleRowIds = new Set<string>([
                                  ...topVisibleRows.map((workspace) => workspace.id),
                                  ...expandedTierVisibleIds,
                                ]);
                                const visibleRows = workspaces.filter((workspace) =>
                                  visibleRowIds.has(workspace.id)
                                );
                                const visibleRowsById = new Map(
                                  visibleRows.map((workspace) => [workspace.id, workspace])
                                );
                                const visibleChildrenByParent = new Map<
                                  string,
                                  FrontendWorkspaceMetadata[]
                                >();
                                for (const workspace of visibleRows) {
                                  const parentId = workspace.parentWorkspaceId;
                                  if (!parentId) {
                                    continue;
                                  }

                                  const siblings = visibleChildrenByParent.get(parentId) ?? [];
                                  siblings.push(workspace);
                                  visibleChildrenByParent.set(parentId, siblings);
                                }

                                const rowMetaByVisibleWorkspaceId = new Map<
                                  string,
                                  AgentRowRenderMeta
                                >();
                                for (const workspace of visibleRows) {
                                  const baseRowMeta = baseRowMetaByWorkspaceId.get(workspace.id);
                                  if (!baseRowMeta) {
                                    continue;
                                  }

                                  const parentId = workspace.parentWorkspaceId;
                                  if (!parentId) {
                                    rowMetaByVisibleWorkspaceId.set(workspace.id, {
                                      ...baseRowMeta,
                                      ancestorTrunks: [],
                                    });
                                    continue;
                                  }

                                  const siblings = visibleChildrenByParent.get(parentId) ?? [];
                                  const siblingIndex = siblings.findIndex(
                                    (sibling) => sibling.id === workspace.id
                                  );
                                  let connectorPosition: AgentRowRenderMeta["connectorPosition"] =
                                    "single";
                                  if (siblings.length > 1) {
                                    connectorPosition =
                                      siblings[siblings.length - 1]?.id === workspace.id
                                        ? "last"
                                        : "middle";
                                  }

                                  let lastRunningSiblingIndex = -1;
                                  for (let index = siblings.length - 1; index >= 0; index -= 1) {
                                    if (siblings[index]?.taskStatus === "running") {
                                      lastRunningSiblingIndex = index;
                                      break;
                                    }
                                  }

                                  const connectorStartsAtParent = siblingIndex === 0;
                                  const sharedTrunkActiveThroughRow =
                                    siblingIndex >= 0 &&
                                    lastRunningSiblingIndex >= 0 &&
                                    siblingIndex <= lastRunningSiblingIndex;
                                  const sharedTrunkActiveBelowRow =
                                    siblingIndex >= 0 &&
                                    lastRunningSiblingIndex >= 0 &&
                                    siblingIndex < lastRunningSiblingIndex;

                                  const ancestorTrunks: Array<{ depth: number; active: boolean }> =
                                    [];
                                  const visitedAncestorIds = new Set<string>();
                                  let ancestorId: string | undefined = parentId;
                                  while (ancestorId && !visitedAncestorIds.has(ancestorId)) {
                                    visitedAncestorIds.add(ancestorId);

                                    const ancestorWorkspace = visibleRowsById.get(ancestorId);
                                    if (!ancestorWorkspace) {
                                      break;
                                    }

                                    const ancestorMeta =
                                      rowMetaByVisibleWorkspaceId.get(ancestorId) ??
                                      baseRowMetaByWorkspaceId.get(ancestorId);
                                    const ancestorDepth = depthByWorkspaceId[ancestorId] ?? 0;
                                    if (
                                      ancestorDepth > 0 &&
                                      ancestorMeta?.connectorPosition === "middle"
                                    ) {
                                      ancestorTrunks.push({
                                        depth: ancestorDepth,
                                        active: ancestorMeta.sharedTrunkActiveBelowRow,
                                      });
                                    }

                                    ancestorId = ancestorWorkspace.parentWorkspaceId;
                                  }
                                  ancestorTrunks.sort((left, right) => left.depth - right.depth);

                                  rowMetaByVisibleWorkspaceId.set(workspace.id, {
                                    ...baseRowMeta,
                                    connectorPosition,
                                    connectorStartsAtParent,
                                    sharedTrunkActiveThroughRow,
                                    sharedTrunkActiveBelowRow,
                                    ancestorTrunks,
                                  });
                                }

                                const renderTier = (tierIndex: number): React.ReactNode => {
                                  const bucket = buckets[tierIndex];
                                  const remainingCount = buckets
                                    .slice(tierIndex)
                                    .reduce((sum, b) => sum + b.length, 0);

                                  if (remainingCount === 0) return null;

                                  const tierKey = `${tierKeyPrefix}:${tierIndex}`;
                                  const isTierExpanded = expandedOldWorkspaces[tierKey] ?? false;
                                  const thresholdDays = AGE_THRESHOLDS_DAYS[tierIndex];
                                  const thresholdLabel = formatDaysThreshold(thresholdDays);
                                  const displayCount = isTierExpanded
                                    ? bucket.length
                                    : remainingCount;

                                  return (
                                    <React.Fragment key={tierKey}>
                                      <button
                                        onClick={() => {
                                          setExpandedOldWorkspaces((prev) => ({
                                            ...prev,
                                            [tierKey]: !prev[tierKey],
                                          }));
                                        }}
                                        aria-label={
                                          isTierExpanded
                                            ? `Collapse workspaces older than ${thresholdLabel}`
                                            : `Expand workspaces older than ${thresholdLabel}`
                                        }
                                        aria-expanded={isTierExpanded}
                                        className="text-muted border-hover hover:text-label [&:hover_.arrow]:text-label flex w-full cursor-pointer items-center justify-between border-t border-none bg-transparent px-3 py-2 pl-[22px] text-xs font-medium transition-all duration-150 hover:bg-white/[0.03]"
                                      >
                                        <div className="flex items-center gap-1.5">
                                          <span>Older than {thresholdLabel}</span>
                                          <span className="text-dim font-normal">
                                            ({displayCount})
                                          </span>
                                        </div>
                                        <span
                                          className="arrow text-dim text-[11px] transition-transform duration-200 ease-in-out"
                                          style={{
                                            transform: isTierExpanded
                                              ? "rotate(90deg)"
                                              : "rotate(0deg)",
                                          }}
                                        >
                                          <ChevronRight size={12} />
                                        </span>
                                      </button>
                                      {isTierExpanded && (
                                        <>
                                          {renderWorkspaceRowsWithBestOfCoalescing({
                                            rows: bucket,
                                            allRows: allRowsForBestOfCoalescing,
                                            sectionId,
                                            rowMetaByWorkspaceId: rowMetaByVisibleWorkspaceId,
                                          })}
                                          {(() => {
                                            const nextTier = findNextNonEmptyTier(
                                              buckets,
                                              tierIndex + 1
                                            );
                                            return nextTier !== -1 ? renderTier(nextTier) : null;
                                          })()}
                                        </>
                                      )}
                                    </React.Fragment>
                                  );
                                };

                                return (
                                  <>
                                    {renderWorkspaceRowsWithBestOfCoalescing({
                                      rows: topVisibleRows,
                                      allRows: allRowsForBestOfCoalescing,
                                      sectionId,
                                      rowMetaByWorkspaceId: rowMetaByVisibleWorkspaceId,
                                    })}
                                    {firstTier !== -1 && renderTier(firstTier)}
                                  </>
                                );
                              };

                              // Partition both the full section membership and the filtered visible rows.
                              // Best-of grouping stays leaf-only by consulting the unfiltered section data,
                              // while actual rendering still follows the visible hierarchy.
                              const {
                                unsectioned: allUnsectionedForNormalRendering,
                                bySectionId: allBySectionIdForNormalRendering,
                              } = partitionWorkspacesBySection(
                                workspacesForNormalRendering,
                                sections
                              );
                              const { unsectioned, bySectionId } = partitionWorkspacesBySection(
                                visibleWorkspacesForNormalRendering,
                                sections
                              );

                              // Handle workspace drop into section
                              const handleWorkspaceSectionDrop = (
                                workspaceId: string,
                                targetSectionId: string | null
                              ) => {
                                void (async () => {
                                  const result = await assignWorkspaceToSection(
                                    projectPath,
                                    workspaceId,
                                    targetSectionId
                                  );
                                  if (result.success) {
                                    // Refresh workspace metadata so UI shows updated sectionId
                                    await refreshWorkspaceMetadata();
                                  }
                                })();
                              };

                              // Handle section reorder (drag section onto another section)
                              const handleSectionReorder = (
                                draggedSectionId: string,
                                targetSectionId: string
                              ) => {
                                void (async () => {
                                  // Compute new order: move dragged section to position of target
                                  const currentOrder = sections.map((s) => s.id);
                                  const draggedIndex = currentOrder.indexOf(draggedSectionId);
                                  const targetIndex = currentOrder.indexOf(targetSectionId);

                                  if (draggedIndex === -1 || targetIndex === -1) return;

                                  // Remove dragged from current position
                                  const newOrder = [...currentOrder];
                                  newOrder.splice(draggedIndex, 1);
                                  // Insert at target position
                                  newOrder.splice(targetIndex, 0, draggedSectionId);

                                  await reorderSections(projectPath, newOrder);
                                })();
                              };

                              // Render section with its workspaces
                              const renderSection = (section: SectionConfig) => {
                                const sectionWorkspaces = bySectionId.get(section.id) ?? [];
                                const sectionAllWorkspaces =
                                  allBySectionIdForNormalRendering.get(section.id) ?? [];
                                const sectionDrafts = draftsBySectionId.get(section.id) ?? [];

                                const sectionExpandedKey = getSectionExpandedKey(
                                  projectPath,
                                  section.id
                                );
                                const isSectionExpanded =
                                  expandedSections[sectionExpandedKey] ?? true;

                                return (
                                  <DraggableSection
                                    key={section.id}
                                    sectionId={section.id}
                                    sectionName={section.name}
                                    projectPath={projectPath}
                                    onReorder={handleSectionReorder}
                                  >
                                    <WorkspaceSectionDropZone
                                      projectPath={projectPath}
                                      sectionId={section.id}
                                      onDrop={handleWorkspaceSectionDrop}
                                    >
                                      <SectionHeader
                                        section={section}
                                        isExpanded={isSectionExpanded}
                                        workspaceCount={
                                          sectionWorkspaces.length + sectionDrafts.length
                                        }
                                        onToggleExpand={() =>
                                          toggleSection(projectPath, section.id)
                                        }
                                        onAddWorkspace={() => {
                                          // Create workspace in this section
                                          handleAddWorkspace(projectPath, section.id);
                                        }}
                                        onRename={(name) => {
                                          void updateSection(projectPath, section.id, { name });
                                        }}
                                        onChangeColor={(color) => {
                                          void updateSection(projectPath, section.id, { color });
                                        }}
                                        onDelete={(e) => {
                                          void handleRemoveSection(
                                            projectPath,
                                            section.id,
                                            e.currentTarget
                                          );
                                        }}
                                      />
                                      {isSectionExpanded && (
                                        <div className="pb-1">
                                          {sectionDrafts.map((draft) => renderDraft(draft))}
                                          {sectionWorkspaces.length > 0 ? (
                                            renderAgeTiers(
                                              sectionWorkspaces,
                                              getSectionTierKey(projectPath, section.id, 0).replace(
                                                ":tier:0",
                                                ":tier"
                                              ),
                                              section.id,
                                              sectionAllWorkspaces
                                            )
                                          ) : sectionDrafts.length === 0 ? (
                                            <div className="text-muted px-3 py-2 text-center text-xs italic">
                                              No workspaces in this section
                                            </div>
                                          ) : null}
                                        </div>
                                      )}
                                    </WorkspaceSectionDropZone>
                                  </DraggableSection>
                                );
                              };

                              return (
                                <>
                                  {/* Unsectioned workspaces first - always show drop zone when sections exist */}
                                  {sections.length > 0 ? (
                                    <WorkspaceSectionDropZone
                                      projectPath={projectPath}
                                      sectionId={null}
                                      onDrop={handleWorkspaceSectionDrop}
                                      testId="unsectioned-drop-zone"
                                    >
                                      {unsectionedDrafts.map((draft) => renderDraft(draft))}
                                      {unsectioned.length > 0 ? (
                                        renderAgeTiers(
                                          unsectioned,
                                          getTierKey(projectPath, 0).replace(":0", ""),
                                          undefined,
                                          allUnsectionedForNormalRendering
                                        )
                                      ) : unsectionedDrafts.length === 0 ? (
                                        <div className="text-muted px-3 py-2 text-center text-xs italic">
                                          No unsectioned workspaces
                                        </div>
                                      ) : null}
                                    </WorkspaceSectionDropZone>
                                  ) : (
                                    <>
                                      {unsectionedDrafts.map((draft) => renderDraft(draft))}
                                      {unsectioned.length > 0 &&
                                        renderAgeTiers(
                                          unsectioned,
                                          getTierKey(projectPath, 0).replace(":0", ""),
                                          undefined,
                                          allUnsectionedForNormalRendering
                                        )}
                                    </>
                                  )}

                                  {/* Sections */}
                                  {sections.map(renderSection)}

                                  {/* Add Section button */}
                                  <AddSectionButton
                                    onCreateSection={(name) => {
                                      void handleCreateSection(projectPath, name);
                                    }}
                                  />
                                </>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
          <SidebarCollapseButton
            collapsed={collapsed}
            onToggle={onToggleCollapsed}
            side="left"
            shortcut={formatKeybind(KEYBINDS.TOGGLE_SIDEBAR)}
          />
          <ConfirmationModal
            isOpen={archiveConfirmation !== null}
            title={
              archiveConfirmation
                ? `Archive "${archiveConfirmation.displayTitle}" while streaming?`
                : "Archive chat?"
            }
            description="This workspace is currently streaming a response."
            warning="Archiving will interrupt the active stream."
            confirmLabel="Archive"
            onConfirm={handleArchiveWorkspaceConfirm}
            onCancel={handleArchiveWorkspaceCancel}
          />
          <ProjectDeleteConfirmationModal
            isOpen={deleteConfirmation !== null}
            projectName={deleteConfirmation?.projectName ?? ""}
            activeCount={deleteConfirmation?.activeCount ?? 0}
            archivedCount={deleteConfirmation?.archivedCount ?? 0}
            onConfirm={handleDeleteConfirm}
            onCancel={handleDeleteCancel}
          />
          <PopoverError
            error={workspaceArchiveError.error}
            prefix="Failed to archive chat"
            onDismiss={workspaceArchiveError.clearError}
          />
          <PopoverError
            error={workspaceStopRuntimeError.error}
            prefix="Failed to stop container"
            onDismiss={workspaceStopRuntimeError.clearError}
          />
          <PopoverError
            error={workspaceForkError.error}
            prefix="Failed to fork chat"
            onDismiss={workspaceForkError.clearError}
          />
          <PopoverError
            error={workspaceRemoveError.error}
            prefix="Failed to cancel workspace creation"
            onDismiss={workspaceRemoveError.clearError}
          />
          <PopoverError
            error={projectRemoveError.error}
            prefix="Failed to remove project"
            onDismiss={projectRemoveError.clearError}
          />
          <PopoverError
            error={sectionRemoveError.error}
            prefix="Failed to remove section"
            onDismiss={sectionRemoveError.clearError}
          />
        </div>
      </DndProvider>
    </TitleEditProvider>
  );
};

// Memoize to prevent re-renders when props haven't changed
const ProjectSidebar = React.memo(ProjectSidebarInner);

export default ProjectSidebar;
