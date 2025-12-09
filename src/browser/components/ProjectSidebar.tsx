import React, { useState, useEffect, useCallback } from "react";
import { cn } from "@/common/lib/utils";
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
  formatDaysThreshold,
  AGE_THRESHOLDS_DAYS,
} from "@/browser/utils/ui/workspaceFiltering";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import SecretsModal from "./SecretsModal";
import type { Secret } from "@/common/types/secrets";
import { ForceDeleteModal } from "./ForceDeleteModal";
import { WorkspaceListItem, type WorkspaceSelection } from "./WorkspaceListItem";
import { RenameProvider } from "@/browser/contexts/WorkspaceRenameContext";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { ChevronRight, KeyRound } from "lucide-react";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import { PopoverError } from "./PopoverError";

// Re-export WorkspaceSelection for backwards compatibility
export type { WorkspaceSelection } from "./WorkspaceListItem";

// Draggable project item moved to module scope to avoid remounting on every parent render.
// Defining components inside another component causes a new function identity each render,
// which forces React to unmount/remount the subtree. That led to hover flicker and high CPU.
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
      item: { projectPath },
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
      className={cn(
        "py-2 px-3 flex items-center border-l-transparent transition-all duration-150 bg-sidebar",
        isDragging ? "cursor-grabbing opacity-40 [&_*]:!cursor-grabbing" : "cursor-grab",
        isOver && "bg-accent/[0.08]",
        selected && "bg-hover border-l-accent",
        "hover:[&_button]:opacity-100 hover:[&_[data-drag-handle]]:opacity-100"
      )}
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
type DragItem = { projectPath: string } | null;

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

  if (!isDragging || !currentOffset || !item?.projectPath) return null;

  const abbrevPath = PlatformPaths.abbreviate(item.projectPath);
  const { dirPath, basename } = PlatformPaths.splitAbbreviated(abbrevPath);

  return (
    <div className="pointer-events-none fixed inset-0 z-[9999] cursor-grabbing">
      <div style={{ transform: `translate(${currentOffset.x + 10}px, ${currentOffset.y + 10}px)` }}>
        <div className="bg-hover/95 text-foreground border-l-accent flex w-fit max-w-72 min-w-44 items-center rounded border-l-[3px] px-3 py-1.5 shadow-[0_6px_24px_rgba(0,0,0,0.4)]">
          <span className="text-muted mr-2 text-xs">▶</span>
          <div className="min-w-0 flex-1">
            <div className="text-muted-dark font-monospace truncate text-sm leading-tight">
              <span>{dirPath}</span>
              <span className="text-foreground font-medium">{basename}</span>
            </div>
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
    removeWorkspace: onRemoveWorkspace,
    renameWorkspace: onRenameWorkspace,
    beginWorkspaceCreation: onAddWorkspace,
  } = useWorkspaceContext();

  // Get project state and operations from context
  const {
    projects,
    openProjectCreateModal: onAddProject,
    removeProject: onRemoveProject,
    getSecrets: onGetSecrets,
    updateSecrets: onUpdateSecrets,
  } = useProjectContext();

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
    (projectPath: string) => {
      onAddWorkspace(projectPath);
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
  // Key format: `${projectPath}:${tierIndex}` where tierIndex is 0, 1, 2 for 1/7/30 days
  const [expandedOldWorkspaces, setExpandedOldWorkspaces] = usePersistedState<
    Record<string, boolean>
  >("expandedOldWorkspaces", {});
  const [deletingWorkspaceIds, setDeletingWorkspaceIds] = useState<Set<string>>(new Set());
  const workspaceRemoveError = usePopoverError();
  const projectRemoveError = usePopoverError();
  const [secretsModalState, setSecretsModalState] = useState<{
    isOpen: boolean;
    projectPath: string;
    projectName: string;
    secrets: Secret[];
  } | null>(null);
  const [forceDeleteModal, setForceDeleteModal] = useState<{
    isOpen: boolean;
    workspaceId: string;
    error: string;
    anchor: { top: number; left: number } | null;
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

  const toggleOldWorkspaces = (projectPath: string, tierIndex: number) => {
    const key = `${projectPath}:${tierIndex}`;
    setExpandedOldWorkspaces((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleRemoveWorkspace = useCallback(
    async (workspaceId: string, buttonElement: HTMLElement) => {
      // Mark workspace as being deleted for UI feedback
      setDeletingWorkspaceIds((prev) => new Set(prev).add(workspaceId));

      try {
        const result = await onRemoveWorkspace(workspaceId);
        if (!result.success) {
          const error = result.error ?? "Failed to remove workspace";
          const rect = buttonElement.getBoundingClientRect();
          const anchor = {
            top: rect.top + window.scrollY,
            left: rect.right + 10, // 10px to the right of button
          };

          // Show force delete modal on any error to handle all cases
          // (uncommitted changes, submodules, etc.)
          setForceDeleteModal({
            isOpen: true,
            workspaceId,
            error,
            anchor,
          });
        }
      } finally {
        // Clear deleting state (workspace removed or error shown)
        setDeletingWorkspaceIds((prev) => {
          const next = new Set(prev);
          next.delete(workspaceId);
          return next;
        });
      }
    },
    [onRemoveWorkspace]
  );

  const handleOpenSecrets = async (projectPath: string) => {
    const secrets = await onGetSecrets(projectPath);
    setSecretsModalState({
      isOpen: true,
      projectPath,
      projectName: getProjectName(projectPath),
      secrets,
    });
  };

  const handleForceDelete = async (workspaceId: string) => {
    const modalState = forceDeleteModal;
    // Close modal immediately to show that action is in progress
    setForceDeleteModal(null);

    // Mark workspace as being deleted for UI feedback
    setDeletingWorkspaceIds((prev) => new Set(prev).add(workspaceId));

    try {
      // Use the same state update logic as regular removal
      const result = await onRemoveWorkspace(workspaceId, { force: true });
      if (!result.success) {
        const errorMessage = result.error ?? "Failed to remove workspace";
        console.error("Force delete failed:", result.error);

        workspaceRemoveError.showError(workspaceId, errorMessage, modalState?.anchor ?? undefined);
      }
    } finally {
      // Clear deleting state
      setDeletingWorkspaceIds((prev) => {
        const next = new Set(prev);
        next.delete(workspaceId);
        return next;
      });
    }
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
        <div
          className="font-primary bg-sidebar border-border-light flex flex-1 flex-col overflow-hidden border-r"
          role="navigation"
          aria-label="Projects"
        >
          {!collapsed && (
            <>
              <div className="border-dark flex items-center justify-between border-b p-4">
                <h2 className="text-foreground m-0 text-lg font-medium">Projects</h2>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={onAddProject}
                      aria-label="Add project"
                      className="text-secondary hover:bg-hover hover:border-border-light flex h-6 w-6 cursor-pointer items-center justify-center rounded border border-transparent bg-transparent p-0 text-2xl transition-all duration-200"
                    >
                      +
                    </button>
                  </TooltipTrigger>
                  <TooltipContent align="end">Add Project</TooltipContent>
                </Tooltip>
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
                                      <span className="text-foreground font-medium">
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
                            className="text-secondary hover:bg-hover hover:border-border-light shrink-0 cursor-pointer rounded border border-transparent bg-transparent px-1.5 py-0.5 text-[11px] transition-all duration-200"
                          >
                            + New Chat
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
                              const allWorkspaces =
                                sortedWorkspacesByProject.get(projectPath) ?? [];
                              const { recent, buckets } = partitionWorkspacesByAge(
                                allWorkspaces,
                                workspaceRecency
                              );

                              const renderWorkspace = (metadata: FrontendWorkspaceMetadata) => (
                                <WorkspaceListItem
                                  key={metadata.id}
                                  metadata={metadata}
                                  projectPath={projectPath}
                                  projectName={projectName}
                                  isSelected={selectedWorkspace?.workspaceId === metadata.id}
                                  isDeleting={deletingWorkspaceIds.has(metadata.id)}
                                  lastReadTimestamp={lastReadTimestamps[metadata.id] ?? 0}
                                  onSelectWorkspace={handleSelectWorkspace}
                                  onRemoveWorkspace={handleRemoveWorkspace}
                                  onToggleUnread={_onToggleUnread}
                                />
                              );

                              // Find the next tier with workspaces (skip empty tiers)
                              const findNextNonEmptyTier = (startIndex: number): number => {
                                for (let i = startIndex; i < buckets.length; i++) {
                                  if (buckets[i].length > 0) return i;
                                }
                                return -1;
                              };

                              // Render a tier and all subsequent tiers recursively
                              // Each tier only shows if the previous tier is expanded
                              // Empty tiers are skipped automatically
                              const renderTier = (tierIndex: number): React.ReactNode => {
                                const bucket = buckets[tierIndex];
                                // Sum remaining workspaces from this tier onward
                                const remainingCount = buckets
                                  .slice(tierIndex)
                                  .reduce((sum, b) => sum + b.length, 0);

                                if (remainingCount === 0) return null;

                                const key = `${projectPath}:${tierIndex}`;
                                const isExpanded = expandedOldWorkspaces[key] ?? false;
                                const thresholdDays = AGE_THRESHOLDS_DAYS[tierIndex];
                                const thresholdLabel = formatDaysThreshold(thresholdDays);

                                return (
                                  <>
                                    <button
                                      onClick={() => toggleOldWorkspaces(projectPath, tierIndex)}
                                      aria-label={
                                        isExpanded
                                          ? `Collapse workspaces older than ${thresholdLabel}`
                                          : `Expand workspaces older than ${thresholdLabel}`
                                      }
                                      aria-expanded={isExpanded}
                                      className="text-muted border-hover hover:text-label [&:hover_.arrow]:text-label flex w-full cursor-pointer items-center justify-between border-t border-none bg-transparent px-3 py-2 pl-[22px] text-xs font-medium transition-all duration-150 hover:bg-white/[0.03]"
                                    >
                                      <div className="flex items-center gap-1.5">
                                        <span>Older than {thresholdLabel}</span>
                                        <span className="text-dim font-normal">
                                          ({remainingCount})
                                        </span>
                                      </div>
                                      <span
                                        className="arrow text-dim text-[11px] transition-transform duration-200 ease-in-out"
                                        style={{
                                          transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                                        }}
                                      >
                                        <ChevronRight size={12} />
                                      </span>
                                    </button>
                                    {isExpanded && (
                                      <>
                                        {bucket.map(renderWorkspace)}
                                        {(() => {
                                          const nextTier = findNextNonEmptyTier(tierIndex + 1);
                                          return nextTier !== -1 ? renderTier(nextTier) : null;
                                        })()}
                                      </>
                                    )}
                                  </>
                                );
                              };

                              // Find first non-empty tier to start rendering
                              const firstTier = findNextNonEmptyTier(0);

                              return (
                                <>
                                  {recent.map(renderWorkspace)}
                                  {firstTier !== -1 && renderTier(firstTier)}
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
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onToggleCollapsed}
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                className="text-muted border-dark hover:bg-hover hover:text-foreground mt-auto flex h-9 w-full cursor-pointer items-center justify-center border-t border-none bg-transparent p-0 text-sm transition-all duration-200"
              >
                {collapsed ? "»" : "«"}
              </button>
            </TooltipTrigger>
            <TooltipContent align="center">
              {collapsed ? "Expand sidebar" : "Collapse sidebar"} (
              {formatKeybind(KEYBINDS.TOGGLE_SIDEBAR)})
            </TooltipContent>
          </Tooltip>
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
          {forceDeleteModal && (
            <ForceDeleteModal
              isOpen={forceDeleteModal.isOpen}
              workspaceId={forceDeleteModal.workspaceId}
              error={forceDeleteModal.error}
              onClose={() => setForceDeleteModal(null)}
              onForceDelete={handleForceDelete}
            />
          )}
          <PopoverError
            error={workspaceRemoveError.error}
            prefix="Failed to remove workspace"
            onDismiss={workspaceRemoveError.clearError}
          />
          <PopoverError
            error={projectRemoveError.error}
            prefix="Failed to remove project"
            onDismiss={projectRemoveError.clearError}
          />
        </div>
      </DndProvider>
    </RenameProvider>
  );
};

// Memoize to prevent re-renders when props haven't changed
const ProjectSidebar = React.memo(ProjectSidebarInner);

export default ProjectSidebar;
