import React, { useState, useEffect, useCallback } from "react";
import { cn } from "@/common/lib/utils";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import MuxLogoDark from "@/browser/assets/logos/mux-logo-dark.svg?react";
import MuxLogoLight from "@/browser/assets/logos/mux-logo-light.svg?react";
import { useTheme } from "@/browser/contexts/ThemeContext";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { EXPANDED_PROJECTS_KEY } from "@/common/constants/storage";
import { DndProvider } from "react-dnd";
import { HTML5Backend, getEmptyImage } from "react-dnd-html5-backend";
import { useDrag, useDrop, useDragLayer } from "react-dnd";
import {
  sortProjectsByOrder,
  reorderProjects,
  normalizeOrder,
} from "@/common/utils/projectOrdering";
import { matchesKeybind, formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { PlatformPaths } from "@/common/utils/paths";
import {
  partitionWorkspacesByAge,
  partitionWorkspacesBySection,
  formatDaysThreshold,
  AGE_THRESHOLDS_DAYS,
  computeWorkspaceDepthMap,
  findNextNonEmptyTier,
  getTierKey,
  getSectionExpandedKey,
  getSectionTierKey,
  sortSectionsByLinkedList,
} from "@/browser/utils/ui/workspaceFiltering";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { SidebarCollapseButton } from "./ui/SidebarCollapseButton";
import SecretsModal from "./SecretsModal";
import type { Secret } from "@/common/types/secrets";

import { WorkspaceListItem, type WorkspaceSelection } from "./WorkspaceListItem";
import { RenameProvider } from "@/browser/contexts/WorkspaceRenameContext";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { ChevronRight, KeyRound } from "lucide-react";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import { PopoverError } from "./PopoverError";
import { SectionHeader } from "./SectionHeader";
import { AddSectionButton } from "./AddSectionButton";
import { WorkspaceSectionDropZone } from "./WorkspaceSectionDropZone";
import { WorkspaceDragLayer } from "./WorkspaceDragLayer";
import { SectionDragLayer } from "./SectionDragLayer";
import { DraggableSection } from "./DraggableSection";
import type { SectionConfig } from "@/common/types/project";

// Re-export WorkspaceSelection for backwards compatibility
export type { WorkspaceSelection } from "./WorkspaceListItem";

// Draggable project item moved to module scope to avoid remounting on every parent render.
// Defining components inside another component causes a new function identity each render,
// which forces React to unmount/remount the subtree. That led to hover flicker and high CPU.

const PROJECT_ITEM_BASE_CLASS =
  "py-2 px-3 flex items-center border-l-transparent bg-sidebar transition-colors duration-150";

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

interface ProjectSidebarProps {
  lastReadTimestamps: Record<string, number>;
  onToggleUnread: (workspaceId: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  sortedWorkspacesByProject: Map<string, FrontendWorkspaceMetadata[]>;
  workspaceRecency: Record<string, number>;
}

const ProjectSidebarInner: React.FC<ProjectSidebarProps> = ({
  lastReadTimestamps,
  onToggleUnread: _onToggleUnread,
  collapsed,
  onToggleCollapsed,
  sortedWorkspacesByProject,
  workspaceRecency,
}) => {
  // Get workspace state and operations from context
  const {
    selectedWorkspace,
    setSelectedWorkspace: onSelectWorkspace,
    archiveWorkspace: onArchiveWorkspace,
    renameWorkspace: onRenameWorkspace,
    beginWorkspaceCreation: onAddWorkspace,
    refreshWorkspaceMetadata,
  } = useWorkspaceContext();

  // Get project state and operations from context
  const {
    projects,
    openProjectCreateModal: onAddProject,
    removeProject: onRemoveProject,
    getSecrets: onGetSecrets,
    updateSecrets: onUpdateSecrets,
    createSection,
    updateSection,
    removeSection,
    reorderSections,
    assignWorkspaceToSection,
  } = useProjectContext();

  // Theme for logo variant
  const { theme } = useTheme();
  const MuxLogo = theme === "dark" || theme === "solarized-dark" ? MuxLogoDark : MuxLogoLight;

  // Mobile breakpoint for auto-closing sidebar
  const MOBILE_BREAKPOINT = 768;

  // Wrapper to close sidebar on mobile after workspace selection
  const handleSelectWorkspace = useCallback(
    (selection: WorkspaceSelection) => {
      onSelectWorkspace(selection);
      if (window.innerWidth <= MOBILE_BREAKPOINT && !collapsed) {
        onToggleCollapsed();
      }
    },
    [onSelectWorkspace, collapsed, onToggleCollapsed]
  );

  // Wrapper to close sidebar on mobile after adding workspace
  const handleAddWorkspace = useCallback(
    (projectPath: string, sectionId?: string) => {
      onAddWorkspace(projectPath, sectionId);
      if (window.innerWidth <= MOBILE_BREAKPOINT && !collapsed) {
        onToggleCollapsed();
      }
    },
    [onAddWorkspace, collapsed, onToggleCollapsed]
  );

  // Workspace-specific subscriptions moved to WorkspaceListItem component

  // Store as array in localStorage, convert to Set for usage
  const [expandedProjectsArray, setExpandedProjectsArray] = usePersistedState<string[]>(
    EXPANDED_PROJECTS_KEY,
    []
  );
  // Handle corrupted localStorage data (old Set stored as {})
  const expandedProjects = new Set(
    Array.isArray(expandedProjectsArray) ? expandedProjectsArray : []
  );

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

  const [archivingWorkspaceIds, setArchivingWorkspaceIds] = useState<Set<string>>(new Set());
  const workspaceArchiveError = usePopoverError();
  const projectRemoveError = usePopoverError();
  const sectionRemoveError = usePopoverError();
  const [secretsModalState, setSecretsModalState] = useState<{
    isOpen: boolean;
    projectPath: string;
    projectName: string;
    secrets: Secret[];
  } | null>(null);

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

  const handleArchiveWorkspace = useCallback(
    async (workspaceId: string, buttonElement: HTMLElement) => {
      // Mark workspace as being archived for UI feedback
      setArchivingWorkspaceIds((prev) => new Set(prev).add(workspaceId));

      try {
        const result = await onArchiveWorkspace(workspaceId);
        if (!result.success) {
          const error = result.error ?? "Failed to archive workspace";
          const rect = buttonElement.getBoundingClientRect();
          const anchor = {
            top: rect.top + window.scrollY,
            left: rect.right + 10,
          };
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

  const handleRemoveSection = async (
    projectPath: string,
    sectionId: string,
    buttonElement: HTMLElement
  ) => {
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

  const handleOpenSecrets = async (projectPath: string) => {
    const secrets = await onGetSecrets(projectPath);
    setSecretsModalState({
      isOpen: true,
      projectPath,
      projectName: getProjectName(projectPath),
      secrets,
    });
  };

  const handleSaveSecrets = async (secrets: Secret[]) => {
    if (secretsModalState) {
      await onUpdateSecrets(secretsModalState.projectPath, secrets);
    }
  };

  const handleCloseSecrets = () => {
    setSecretsModalState(null);
  };

  // UI preference: project order persists in localStorage
  const [projectOrder, setProjectOrder] = usePersistedState<string[]>("mux:projectOrder", []);

  // Build a stable signature of the project keys so effects don't fire on Map identity churn
  const projectPathsSignature = React.useMemo(() => {
    // sort to avoid order-related churn
    const keys = Array.from(projects.keys()).sort();
    return keys.join("\u0001"); // use non-printable separator
  }, [projects]);

  // Normalize order when the set of projects changes (not on every parent render)
  useEffect(() => {
    // Skip normalization if projects haven't loaded yet (empty Map on initial render)
    // This prevents clearing projectOrder before projects load from backend
    if (projects.size === 0) {
      return;
    }

    const normalized = normalizeOrder(projectOrder, projects);
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
    () => sortProjectsByOrder(projects, projectOrder).map(([p]) => p),
    // projectPathsSignature captures projects Map keys
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectPathsSignature, projectOrder]
  );

  const handleReorder = useCallback(
    (draggedPath: string, targetPath: string) => {
      const next = reorderProjects(projectOrder, projects, draggedPath, targetPath);
      setProjectOrder(next);
    },
    [projectOrder, projects, setProjectOrder]
  );

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Create new workspace for the project of the selected workspace
      if (matchesKeybind(e, KEYBINDS.NEW_WORKSPACE) && selectedWorkspace) {
        e.preventDefault();
        handleAddWorkspace(selectedWorkspace.projectPath);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedWorkspace, handleAddWorkspace]);

  return (
    <RenameProvider onRenameWorkspace={onRenameWorkspace}>
      <DndProvider backend={HTML5Backend}>
        <ProjectDragLayer />
        <WorkspaceDragLayer />
        <SectionDragLayer />
        <div
          className={cn(
            "font-primary bg-sidebar border-border-light flex flex-1 flex-col overflow-hidden border-r",
            // In desktop mode when collapsed, hide border (LeftSidebar handles the partial border)
            isDesktopMode() && collapsed && "border-r-0"
          )}
          role="navigation"
          aria-label="Projects"
        >
          {!collapsed && (
            <>
              <div className="border-dark flex items-center justify-between border-b py-3 pr-3 pl-4">
                <MuxLogo className="h-5 w-[44px]" aria-label="Projects" />
                <button
                  onClick={onAddProject}
                  aria-label="Add project"
                  className="text-secondary hover:bg-hover hover:border-border-light flex h-6 cursor-pointer items-center gap-1 rounded border border-transparent bg-transparent px-1.5 text-xs transition-all duration-200"
                >
                  <span className="text-base leading-none">+</span>
                  <span>New Project</span>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                {projects.size === 0 ? (
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
                    const config = projects.get(projectPath);
                    if (!config) return null;
                    const projectName = getProjectName(projectPath);
                    const sanitizedProjectId =
                      projectPath.replace(/[^a-zA-Z0-9_-]/g, "-") || "root";
                    const workspaceListId = `workspace-list-${sanitizedProjectId}`;
                    const isExpanded = expandedProjects.has(projectPath);

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
                            className="text-secondary hover:bg-hover hover:border-border-light mr-2 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-transparent bg-transparent p-0 transition-all duration-200"
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
                                  void handleOpenSecrets(projectPath);
                                }}
                                aria-label={`Manage secrets for ${projectName}`}
                                data-project-path={projectPath}
                                className="text-muted-dark mr-1 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent text-sm opacity-0 transition-all duration-200 hover:bg-yellow-500/10 hover:text-yellow-500"
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
                                  void (async () => {
                                    const result = await onRemoveProject(projectPath);
                                    if (!result.success) {
                                      const error = result.error ?? "Failed to remove project";
                                      const rect = buttonElement.getBoundingClientRect();
                                      const anchor = {
                                        top: rect.top + window.scrollY,
                                        left: rect.right + 10,
                                      };
                                      projectRemoveError.showError(projectPath, error, anchor);
                                    }
                                  })();
                                }}
                                aria-label={`Remove project ${projectName}`}
                                data-project-path={projectPath}
                                className="text-muted-dark hover:text-danger-light hover:bg-danger-light/10 mr-1 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent text-base opacity-0 transition-all duration-200"
                              >
                                ×
                              </button>
                            </TooltipTrigger>
                            <TooltipContent align="end">Remove project</TooltipContent>
                          </Tooltip>
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
                                sortedWorkspacesByProject.get(projectPath) ?? [];
                              const sections = sortSectionsByLinkedList(config.sections ?? []);
                              const depthByWorkspaceId = computeWorkspaceDepthMap(allWorkspaces);

                              const renderWorkspace = (
                                metadata: FrontendWorkspaceMetadata,
                                sectionId?: string
                              ) => (
                                <WorkspaceListItem
                                  key={metadata.id}
                                  metadata={metadata}
                                  projectPath={projectPath}
                                  projectName={projectName}
                                  isSelected={selectedWorkspace?.workspaceId === metadata.id}
                                  isArchiving={archivingWorkspaceIds.has(metadata.id)}
                                  lastReadTimestamp={lastReadTimestamps[metadata.id] ?? 0}
                                  onSelectWorkspace={handleSelectWorkspace}
                                  onArchiveWorkspace={handleArchiveWorkspace}
                                  onToggleUnread={_onToggleUnread}
                                  depth={depthByWorkspaceId[metadata.id] ?? 0}
                                  sectionId={sectionId}
                                />
                              );

                              // Render age tiers for a list of workspaces
                              const renderAgeTiers = (
                                workspaces: FrontendWorkspaceMetadata[],
                                tierKeyPrefix: string,
                                sectionId?: string
                              ): React.ReactNode => {
                                const { recent, buckets } = partitionWorkspacesByAge(
                                  workspaces,
                                  workspaceRecency
                                );

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
                                          {bucket.map((ws) => renderWorkspace(ws, sectionId))}
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

                                const firstTier = findNextNonEmptyTier(buckets, 0);

                                return (
                                  <>
                                    {recent.map((ws) => renderWorkspace(ws, sectionId))}
                                    {firstTier !== -1 && renderTier(firstTier)}
                                  </>
                                );
                              };

                              // Partition workspaces by section
                              const { unsectioned, bySectionId } = partitionWorkspacesBySection(
                                allWorkspaces,
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
                                        workspaceCount={sectionWorkspaces.length}
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
                                          {sectionWorkspaces.length > 0 ? (
                                            renderAgeTiers(
                                              sectionWorkspaces,
                                              getSectionTierKey(projectPath, section.id, 0).replace(
                                                ":tier:0",
                                                ":tier"
                                              ),
                                              section.id
                                            )
                                          ) : (
                                            <div className="text-muted px-3 py-2 text-center text-xs italic">
                                              No workspaces in this section
                                            </div>
                                          )}
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
                                      {unsectioned.length > 0 ? (
                                        renderAgeTiers(
                                          unsectioned,
                                          getTierKey(projectPath, 0).replace(":0", "")
                                        )
                                      ) : (
                                        <div className="text-muted px-3 py-2 text-center text-xs italic">
                                          No unsectioned workspaces
                                        </div>
                                      )}
                                    </WorkspaceSectionDropZone>
                                  ) : (
                                    unsectioned.length > 0 &&
                                    renderAgeTiers(
                                      unsectioned,
                                      getTierKey(projectPath, 0).replace(":0", "")
                                    )
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
          {secretsModalState && (
            <SecretsModal
              isOpen={secretsModalState.isOpen}
              projectPath={secretsModalState.projectPath}
              projectName={secretsModalState.projectName}
              initialSecrets={secretsModalState.secrets}
              onClose={handleCloseSecrets}
              onSave={handleSaveSecrets}
            />
          )}
          <PopoverError
            error={workspaceArchiveError.error}
            prefix="Failed to archive workspace"
            onDismiss={workspaceArchiveError.clearError}
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
    </RenameProvider>
  );
};

// Memoize to prevent re-renders when props haven't changed
const ProjectSidebar = React.memo(ProjectSidebarInner);

export default ProjectSidebar;
