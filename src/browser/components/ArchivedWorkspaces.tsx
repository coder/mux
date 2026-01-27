import React from "react";

import { cn } from "@/common/lib/utils";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useAPI } from "@/browser/contexts/API";
import { ChevronDown, ChevronRight, Loader2, Search, Trash2 } from "lucide-react";
import { ArchiveIcon, ArchiveRestoreIcon } from "./icons/ArchiveIcon";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { RuntimeBadge } from "./RuntimeBadge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/browser/components/ui/dialog";
import { ForceDeleteModal } from "./ForceDeleteModal";
import { Button } from "@/browser/components/ui/button";
import type { z } from "zod";
import type { SessionUsageFileSchema } from "@/common/orpc/schemas/chatStats";
import {
  sumUsageHistory,
  getTotalCost,
  formatCostWithDollar,
} from "@/common/utils/tokens/usageAggregator";

type SessionUsageFile = z.infer<typeof SessionUsageFileSchema>;

interface ArchivedWorkspacesProps {
  projectPath: string;
  projectName: string;
  workspaces: FrontendWorkspaceMetadata[];
  /** Called after a workspace is unarchived or deleted to refresh the list */
  onWorkspacesChanged?: () => void;
}

interface BulkOperationState {
  type: "restore" | "delete";
  total: number;
  completed: number;
  current: string | null;
  errors: string[];
}

/** Group workspaces by time period for timeline display */
function groupByTimePeriod(
  workspaces: FrontendWorkspaceMetadata[]
): Map<string, FrontendWorkspaceMetadata[]> {
  const groups = new Map<string, FrontendWorkspaceMetadata[]>();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const lastWeek = new Date(today.getTime() - 7 * 86400000);
  const lastMonth = new Date(today.getTime() - 30 * 86400000);

  // Sort by archivedAt descending (most recent first)
  const sorted = [...workspaces].sort((a, b) => {
    const aTime = a.archivedAt ? new Date(a.archivedAt).getTime() : 0;
    const bTime = b.archivedAt ? new Date(b.archivedAt).getTime() : 0;
    return bTime - aTime;
  });

  for (const ws of sorted) {
    const archivedDate = ws.archivedAt ? new Date(ws.archivedAt) : null;
    let period: string;

    if (!archivedDate) {
      period = "Unknown";
    } else if (archivedDate >= today) {
      period = "Today";
    } else if (archivedDate >= yesterday) {
      period = "Yesterday";
    } else if (archivedDate >= lastWeek) {
      period = "This Week";
    } else if (archivedDate >= lastMonth) {
      period = "This Month";
    } else {
      // Group by month/year for older items
      period = archivedDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }

    const existing = groups.get(period) ?? [];
    existing.push(ws);
    groups.set(period, existing);
  }

  return groups;
}

/** Flatten grouped workspaces back to ordered array for index-based selection */
function flattenGrouped(
  grouped: Map<string, FrontendWorkspaceMetadata[]>
): FrontendWorkspaceMetadata[] {
  const result: FrontendWorkspaceMetadata[] = [];
  for (const workspaces of grouped.values()) {
    result.push(...workspaces);
  }
  return result;
}

/** Calculate total cost from a SessionUsageFile by summing all model usages */
function getSessionTotalCost(usage: SessionUsageFile | undefined): number | undefined {
  if (!usage) return undefined;
  const aggregated = sumUsageHistory(Object.values(usage.byModel));
  return getTotalCost(aggregated);
}

/** Cost badge component with size variants for different scopes */
const CostBadge: React.FC<{
  cost: number | undefined;
  size?: "sm" | "md" | "lg";
  className?: string;
}> = ({ cost, size = "md", className }) => {
  if (cost === undefined) return null;
  const sizeStyles = {
    sm: "px-1 py-0.5 text-[10px]",
    md: "px-1.5 py-0.5 text-xs",
    lg: "px-2 py-0.5 text-sm",
  };
  return (
    <span
      className={cn(
        "text-muted inline-flex items-center rounded bg-white/5 tabular-nums",
        sizeStyles[size],
        className
      )}
    >
      {formatCostWithDollar(cost)}
    </span>
  );
};

/** Progress modal for bulk operations */
const BulkProgressModal: React.FC<{
  operation: BulkOperationState;
  onClose: () => void;
}> = ({ operation, onClose }) => {
  const percentage = Math.round((operation.completed / operation.total) * 100);
  const isComplete = operation.completed === operation.total;
  const actionVerb = operation.type === "restore" ? "Restoring" : "Deleting";
  const actionPast = operation.type === "restore" ? "restored" : "deleted";

  return (
    <Dialog open onOpenChange={(open) => !open && isComplete && onClose()}>
      <DialogContent maxWidth="400px" showCloseButton={isComplete}>
        <DialogHeader>
          <DialogTitle>{isComplete ? "Complete" : `${actionVerb} Workspaces`}</DialogTitle>
          <DialogDescription>
            {isComplete ? (
              <>
                Successfully {actionPast} {operation.completed} workspace
                {operation.completed !== 1 && "s"}
                {operation.errors.length > 0 && ` (${operation.errors.length} failed)`}
              </>
            ) : (
              <>
                {operation.completed} of {operation.total} complete
                {operation.current && <> — {operation.current}</>}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Progress bar */}
        <div className="bg-separator h-2 overflow-hidden rounded-full">
          <div
            className={cn(
              "h-full transition-all duration-300",
              operation.type === "restore" ? "bg-green-500" : "bg-red-500"
            )}
            style={{ width: `${percentage}%` }}
          />
        </div>

        {/* Errors */}
        {operation.errors.length > 0 && (
          <div className="max-h-32 overflow-y-auto rounded bg-red-500/10 p-2 text-xs text-red-400">
            {operation.errors.map((err, i) => (
              <div key={i}>{err}</div>
            ))}
          </div>
        )}

        {isComplete && (
          <DialogFooter className="justify-center">
            <Button variant="secondary" onClick={onClose} className="w-full">
              Done
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};

/**
 * Section showing archived workspaces for a project.
 * Appears on the project page when there are archived workspaces.
 */
export const ArchivedWorkspaces: React.FC<ArchivedWorkspacesProps> = ({
  projectPath: _projectPath,
  projectName: _projectName,
  workspaces,
  onWorkspacesChanged,
}) => {
  const [isExpanded, setIsExpanded] = usePersistedState(
    `archivedWorkspacesExpanded:${_projectPath}`,
    false
  );
  const archivedRegionId = React.useId();

  const { unarchiveWorkspace, removeWorkspace, setSelectedWorkspace } = useWorkspaceContext();
  const { api } = useAPI();
  const [searchQuery, setSearchQuery] = React.useState("");
  const [processingIds, setProcessingIds] = React.useState<Set<string>>(new Set());
  const [forceDeleteModal, setForceDeleteModal] = React.useState<{
    workspaceId: string;
    error: string;
  } | null>(null);

  // Bulk selection state
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [lastClickedId, setLastClickedId] = React.useState<string | null>(null);
  const [bulkOperation, setBulkOperation] = React.useState<BulkOperationState | null>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = React.useState(false);

  const handleToggleExpanded = () => {
    setIsExpanded((prev) => {
      const next = !prev;

      // Clear selection when collapsing so hidden items can't be bulk-acted later.
      if (!next) {
        setSelectedIds(new Set());
        setLastClickedId(null);
        setBulkDeleteConfirm(false);
      }

      return next;
    });
  };

  // Cost data for workspaces
  const [usageByWorkspace, setUsageByWorkspace] = React.useState<
    Record<string, SessionUsageFile | undefined>
  >({});

  // Fetch costs for all workspaces on mount or when workspaces change
  React.useEffect(() => {
    if (!api || workspaces.length === 0) return;
    const workspaceIds = workspaces.map((w) => w.id);
    api.workspace
      .getSessionUsageBatch({ workspaceIds })
      .then(setUsageByWorkspace)
      .catch(() => {
        // Silently fail - costs are optional
      });
  }, [api, workspaces]);

  // Filter workspaces by search query (frontend-only)
  const filteredWorkspaces = searchQuery.trim()
    ? workspaces.filter((ws) => {
        const query = searchQuery.toLowerCase();
        const title = (ws.title ?? ws.name).toLowerCase();
        const name = ws.name.toLowerCase();
        return title.includes(query) || name.includes(query);
      })
    : workspaces;

  // Group filtered workspaces by time period
  const groupedWorkspaces = groupByTimePeriod(filteredWorkspaces);
  const flatWorkspaces = flattenGrouped(groupedWorkspaces);

  // Calculate total cost and per-period costs
  const totalCost = React.useMemo(() => {
    let sum = 0;
    let hasCost = false;
    for (const ws of workspaces) {
      const cost = getSessionTotalCost(usageByWorkspace[ws.id]);
      if (cost !== undefined) {
        sum += cost;
        hasCost = true;
      }
    }
    return hasCost ? sum : undefined;
  }, [workspaces, usageByWorkspace]);

  const periodCosts = React.useMemo(() => {
    const costs = new Map<string, number | undefined>();
    for (const [period, periodWorkspaces] of groupedWorkspaces) {
      let sum = 0;
      let hasCost = false;
      for (const ws of periodWorkspaces) {
        const cost = getSessionTotalCost(usageByWorkspace[ws.id]);
        if (cost !== undefined) {
          sum += cost;
          hasCost = true;
        }
      }
      costs.set(period, hasCost ? sum : undefined);
    }
    return costs;
  }, [groupedWorkspaces, usageByWorkspace]);

  // workspaces prop should already be filtered to archived only
  if (workspaces.length === 0) {
    return null;
  }

  // Handle checkbox click with shift-click range selection
  const handleCheckboxClick = (workspaceId: string, event: React.MouseEvent) => {
    const isShiftClick = event.shiftKey;

    setSelectedIds((prev) => {
      const next = new Set(prev);

      if (isShiftClick && lastClickedId) {
        // Range selection
        const lastIndex = flatWorkspaces.findIndex((w) => w.id === lastClickedId);
        const currentIndex = flatWorkspaces.findIndex((w) => w.id === workspaceId);

        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex);
          const end = Math.max(lastIndex, currentIndex);

          for (let i = start; i <= end; i++) {
            next.add(flatWorkspaces[i].id);
          }
        }
      } else {
        // Toggle single selection
        if (next.has(workspaceId)) {
          next.delete(workspaceId);
        } else {
          next.add(workspaceId);
        }
      }

      return next;
    });

    setLastClickedId(workspaceId);
    setBulkDeleteConfirm(false); // Clear confirmation when selection changes
  };

  // Select/deselect all filtered workspaces
  const handleSelectAll = () => {
    const allFilteredIds = new Set(filteredWorkspaces.map((w) => w.id));
    const allSelected = filteredWorkspaces.every((w) => selectedIds.has(w.id));

    if (allSelected) {
      // Deselect all filtered
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of allFilteredIds) {
          next.delete(id);
        }
        return next;
      });
    } else {
      // Select all filtered
      setSelectedIds((prev) => new Set([...prev, ...allFilteredIds]));
    }
    setBulkDeleteConfirm(false); // Clear confirmation when selection changes
  };

  // Bulk restore
  const handleBulkRestore = async () => {
    const idsToRestore = Array.from(selectedIds);
    setBulkOperation({
      type: "restore",
      total: idsToRestore.length,
      completed: 0,
      current: null,
      errors: [],
    });

    for (let i = 0; i < idsToRestore.length; i++) {
      const id = idsToRestore[i];
      const ws = workspaces.find((w) => w.id === id);
      setBulkOperation((prev) => (prev ? { ...prev, current: ws?.title ?? ws?.name ?? id } : prev));

      try {
        const result = await unarchiveWorkspace(id);
        if (!result.success) {
          setBulkOperation((prev) =>
            prev
              ? {
                  ...prev,
                  errors: [
                    ...prev.errors,
                    `Failed to restore ${ws?.name ?? id}${result.error ? `: ${result.error}` : ""}`,
                  ],
                }
              : prev
          );
        }
      } catch {
        setBulkOperation((prev) =>
          prev ? { ...prev, errors: [...prev.errors, `Failed to restore ${ws?.name ?? id}`] } : prev
        );
      }

      setBulkOperation((prev) => (prev ? { ...prev, completed: i + 1 } : prev));
    }

    setSelectedIds(new Set());
    onWorkspacesChanged?.();
  };

  // Bulk delete (always force: true) - requires confirmation
  const handleBulkDelete = async () => {
    setBulkDeleteConfirm(false);
    const idsToDelete = Array.from(selectedIds);
    setBulkOperation({
      type: "delete",
      total: idsToDelete.length,
      completed: 0,
      current: null,
      errors: [],
    });

    for (let i = 0; i < idsToDelete.length; i++) {
      const id = idsToDelete[i];
      const ws = workspaces.find((w) => w.id === id);
      setBulkOperation((prev) => (prev ? { ...prev, current: ws?.title ?? ws?.name ?? id } : prev));

      try {
        const result = await removeWorkspace(id, { force: true });
        if (!result.success) {
          setBulkOperation((prev) =>
            prev
              ? {
                  ...prev,
                  errors: [
                    ...prev.errors,
                    `Failed to delete ${ws?.name ?? id}${result.error ? `: ${result.error}` : ""}`,
                  ],
                }
              : prev
          );
        }
      } catch {
        setBulkOperation((prev) =>
          prev ? { ...prev, errors: [...prev.errors, `Failed to delete ${ws?.name ?? id}`] } : prev
        );
      }

      setBulkOperation((prev) => (prev ? { ...prev, completed: i + 1 } : prev));
    }

    setSelectedIds(new Set());
    onWorkspacesChanged?.();
  };

  const handleUnarchive = async (workspaceId: string) => {
    setProcessingIds((prev) => new Set(prev).add(workspaceId));
    try {
      const result = await unarchiveWorkspace(workspaceId);
      if (result.success) {
        // Select the workspace after unarchiving
        const workspace = workspaces.find((w) => w.id === workspaceId);
        if (workspace) {
          setSelectedWorkspace({
            workspaceId: workspace.id,
            projectPath: workspace.projectPath,
            projectName: workspace.projectName,
            namedWorkspacePath: workspace.namedWorkspacePath,
          });
        }
        onWorkspacesChanged?.();
      }
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(workspaceId);
        return next;
      });
    }
  };

  const handleDelete = async (workspaceId: string) => {
    setProcessingIds((prev) => new Set(prev).add(workspaceId));
    try {
      const result = await removeWorkspace(workspaceId);
      if (result.success) {
        onWorkspacesChanged?.();
      } else {
        setForceDeleteModal({
          workspaceId,
          error: result.error ?? "Failed to remove workspace",
        });
      }
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(workspaceId);
        return next;
      });
    }
  };

  const hasSelection = selectedIds.size > 0;
  const allFilteredSelected =
    filteredWorkspaces.length > 0 && filteredWorkspaces.every((w) => selectedIds.has(w.id));

  return (
    <>
      {/* Bulk operation progress modal */}

      <ForceDeleteModal
        isOpen={forceDeleteModal !== null}
        workspaceId={forceDeleteModal?.workspaceId ?? ""}
        error={forceDeleteModal?.error ?? ""}
        onClose={() => setForceDeleteModal(null)}
        onForceDelete={async (workspaceId) => {
          const result = await removeWorkspace(workspaceId, { force: true });
          if (!result.success) {
            throw new Error(result.error ?? "Force delete failed");
          }
          onWorkspacesChanged?.();
        }}
      />
      {bulkOperation && (
        <BulkProgressModal operation={bulkOperation} onClose={() => setBulkOperation(null)} />
      )}

      <div className="border-border rounded-lg border">
        {/* Header with bulk actions */}
        <div className="flex items-center gap-2 px-4 py-3">
          <button
            type="button"
            onClick={handleToggleExpanded}
            className="text-muted hover:text-foreground rounded p-1 transition-colors hover:bg-white/10"
            aria-label={isExpanded ? "Collapse archived workspaces" : "Expand archived workspaces"}
            aria-expanded={isExpanded}
            aria-controls={archivedRegionId}
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
          <ArchiveIcon className="text-muted h-4 w-4" />
          <span className="text-foreground font-medium">
            Archived Workspaces ({workspaces.length})
          </span>
          <CostBadge cost={totalCost} size="lg" />
          <span className="flex-1" />
          {isExpanded && hasSelection && (
            <div className="flex items-center gap-2">
              <span className="text-muted text-xs">{selectedIds.size} selected</span>
              {bulkDeleteConfirm ? (
                <>
                  <span className="text-muted text-xs">
                    Delete permanently (also deletes local branches)?
                  </span>
                  <button
                    onClick={() => void handleBulkDelete()}
                    className="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
                  >
                    Yes, delete {selectedIds.size}
                  </button>
                  <button
                    onClick={() => setBulkDeleteConfirm(false)}
                    className="text-muted hover:text-foreground text-xs"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => void handleBulkRestore()}
                        className="text-muted hover:text-foreground rounded p-1 transition-colors hover:bg-white/10"
                        aria-label="Restore selected"
                      >
                        <ArchiveRestoreIcon className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Restore selected</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setBulkDeleteConfirm(true)}
                        className="text-muted rounded p-1 transition-colors hover:bg-white/10 hover:text-red-400"
                        aria-label="Delete selected"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Delete selected permanently (local branches too)
                    </TooltipContent>
                  </Tooltip>
                  <button
                    onClick={() => setSelectedIds(new Set())}
                    className="text-muted hover:text-foreground ml-1 text-xs"
                  >
                    Clear
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {isExpanded && (
          <div
            id={archivedRegionId}
            role="region"
            aria-label="Archived workspaces"
            className="border-border border-t"
          >
            {/* Search input with select all */}
            {workspaces.length > 1 && (
              <div className="border-border flex items-center gap-2 border-b px-4 py-2">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={handleSelectAll}
                  className="h-4 w-4 rounded border-gray-600 bg-transparent"
                  aria-label="Select all"
                />
                {workspaces.length > 3 && (
                  <div className="relative flex-1">
                    <Search className="text-muted pointer-events-none absolute top-1/2 left-2 h-4 w-4 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="Search archived workspaces or branches..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="bg-bg-dark placeholder:text-muted text-foreground focus:border-border-light w-full rounded border border-transparent py-1.5 pr-3 pl-8 text-sm focus:outline-none"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Timeline grouped list */}
            <div>
              {filteredWorkspaces.length === 0 ? (
                <div className="text-muted px-4 py-6 text-center text-sm">
                  No workspaces match {`"${searchQuery}"`}
                </div>
              ) : (
                Array.from(groupedWorkspaces.entries()).map(([period, periodWorkspaces]) => (
                  <div key={period}>
                    {/* Period header */}
                    <div className="bg-bg-dark text-muted flex items-center gap-2 px-4 py-1.5 text-xs font-medium">
                      <span>{period}</span>
                      <CostBadge cost={periodCosts.get(period)} />
                    </div>
                    {/* Workspaces in this period */}
                    {periodWorkspaces.map((workspace) => {
                      const isProcessing = processingIds.has(workspace.id) || workspace.isRemoving;
                      const isSelected = selectedIds.has(workspace.id);
                      const workspaceNameForTooltip =
                        workspace.title && workspace.title !== workspace.name
                          ? workspace.name
                          : undefined;
                      const displayTitle = workspace.title ?? workspace.name;

                      return (
                        <div
                          key={workspace.id}
                          className={cn(
                            "border-border flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0",
                            isProcessing && "opacity-50",
                            isSelected && "bg-white/5"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onClick={(e) => handleCheckboxClick(workspace.id, e)}
                            onChange={() => undefined} // Controlled by onClick for shift-click support
                            className="h-4 w-4 rounded border-gray-600 bg-transparent"
                            aria-label={`Select ${displayTitle}`}
                          />
                          <RuntimeBadge
                            runtimeConfig={workspace.runtimeConfig}
                            isWorking={false}
                            workspacePath={workspace.namedWorkspacePath}
                            workspaceName={workspaceNameForTooltip}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-foreground truncate text-sm font-medium">
                              {displayTitle}
                            </div>
                            <div className="flex items-center gap-2">
                              {workspace.archivedAt && (
                                <span className="text-muted text-xs">
                                  {new Date(workspace.archivedAt).toLocaleString(undefined, {
                                    month: "short",
                                    day: "numeric",
                                    hour: "numeric",
                                    minute: "2-digit",
                                  })}
                                </span>
                              )}
                              <CostBadge
                                cost={getSessionTotalCost(usageByWorkspace[workspace.id])}
                                size="sm"
                              />
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={() => void handleUnarchive(workspace.id)}
                                  disabled={isProcessing}
                                  className="text-muted hover:text-foreground rounded p-1.5 transition-colors hover:bg-white/10 disabled:opacity-50"
                                  aria-label={`Restore workspace ${displayTitle}`}
                                >
                                  <ArchiveRestoreIcon className="h-4 w-4" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>Restore to sidebar</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={() => void handleDelete(workspace.id)}
                                  disabled={isProcessing}
                                  className="text-muted rounded p-1.5 transition-colors hover:bg-white/10 hover:text-red-400 disabled:opacity-50"
                                  aria-label={`Delete workspace ${displayTitle}`}
                                >
                                  {isProcessing ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="h-4 w-4" />
                                  )}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>Delete permanently (local branch too)</TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
};
