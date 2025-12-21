import React from "react";
import { cn } from "@/common/lib/utils";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { Trash2, Search } from "lucide-react";
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
import { Button } from "@/browser/components/ui/button";

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
function groupByTimePeriod(workspaces: FrontendWorkspaceMetadata[]): Map<string, FrontendWorkspaceMetadata[]> {
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
function flattenGrouped(grouped: Map<string, FrontendWorkspaceMetadata[]>): FrontendWorkspaceMetadata[] {
  const result: FrontendWorkspaceMetadata[] = [];
  for (const workspaces of grouped.values()) {
    result.push(...workspaces);
  }
  return result;
}

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
  const { unarchiveWorkspace, removeWorkspace, setSelectedWorkspace } = useWorkspaceContext();
  const [searchQuery, setSearchQuery] = React.useState("");
  const [processingIds, setProcessingIds] = React.useState<Set<string>>(new Set());
  const [deleteConfirmId, setDeleteConfirmId] = React.useState<string | null>(null);

  // Bulk selection state
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [lastClickedId, setLastClickedId] = React.useState<string | null>(null);
  const [bulkOperation, setBulkOperation] = React.useState<BulkOperationState | null>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = React.useState(false);

  // workspaces prop should already be filtered to archived only
  if (workspaces.length === 0) {
    return null;
  }

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
      setBulkOperation((prev) =>
        prev ? { ...prev, current: ws?.title ?? ws?.name ?? id } : prev
      );

      try {
        await unarchiveWorkspace(id);
      } catch (err) {
        setBulkOperation((prev) =>
          prev
            ? { ...prev, errors: [...prev.errors, `Failed to restore ${ws?.name ?? id}`] }
            : prev
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
      setBulkOperation((prev) =>
        prev ? { ...prev, current: ws?.title ?? ws?.name ?? id } : prev
      );

      try {
        await removeWorkspace(id, { force: true });
      } catch (err) {
        setBulkOperation((prev) =>
          prev
            ? { ...prev, errors: [...prev.errors, `Failed to delete ${ws?.name ?? id}`] }
            : prev
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
    setDeleteConfirmId(null);
    try {
      await removeWorkspace(workspaceId, { force: true });
      onWorkspacesChanged?.();
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
      {bulkOperation && (
        <BulkProgressModal operation={bulkOperation} onClose={() => setBulkOperation(null)} />
      )}

      <div className="border-border rounded-lg border">
        {/* Header with bulk actions */}
        <div className="flex items-center gap-2 px-4 py-3">
          <ArchiveIcon className="text-muted h-4 w-4" />
          <span className="text-foreground flex-1 font-medium">
            Archived Workspaces ({workspaces.length})
          </span>
          {hasSelection && (
            <div className="flex items-center gap-2">
              <span className="text-muted text-xs">{selectedIds.size} selected</span>
              {bulkDeleteConfirm ? (
                <>
                  <span className="text-muted text-xs">Delete permanently?</span>
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
                    <TooltipContent>Delete selected permanently</TooltipContent>
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

        <div className="border-border border-t">
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
                  <Search className="text-muted pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Search archived workspaces..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="bg-bg-dark placeholder:text-muted text-foreground w-full rounded border border-transparent py-1.5 pl-8 pr-3 text-sm focus:border-border-light focus:outline-none"
                  />
                </div>
              )}
            </div>
          )}

          {/* Timeline grouped list */}
          <div>
            {filteredWorkspaces.length === 0 ? (
              <div className="text-muted px-4 py-6 text-center text-sm">
                No workspaces match "{searchQuery}"
              </div>
            ) : (
              Array.from(groupedWorkspaces.entries()).map(([period, periodWorkspaces]) => (
                <div key={period}>
                  {/* Period header */}
                  <div className="bg-bg-dark text-muted px-4 py-1.5 text-xs font-medium">
                    {period}
                  </div>
                  {/* Workspaces in this period */}
                  {periodWorkspaces.map((workspace) => {
                    const isProcessing = processingIds.has(workspace.id);
                    const isDeleting = deleteConfirmId === workspace.id;
                    const isSelected = selectedIds.has(workspace.id);
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
                          onChange={() => {}} // Controlled by onClick for shift-click support
                          className="h-4 w-4 rounded border-gray-600 bg-transparent"
                          aria-label={`Select ${displayTitle}`}
                        />
                        <RuntimeBadge runtimeConfig={workspace.runtimeConfig} isWorking={false} />
                        <div className="min-w-0 flex-1">
                          <div className="text-foreground truncate text-sm font-medium">
                            {displayTitle}
                          </div>
                          {workspace.archivedAt && (
                            <div className="text-muted text-xs">
                              {new Date(workspace.archivedAt).toLocaleString(undefined, {
                                month: "short",
                                day: "numeric",
                                hour: "numeric",
                                minute: "2-digit",
                              })}
                            </div>
                          )}
                        </div>

                        {isDeleting ? (
                          <div className="flex items-center gap-2">
                            <span className="text-muted text-xs">Delete?</span>
                            <button
                              onClick={() => void handleDelete(workspace.id)}
                              disabled={isProcessing}
                              className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
                            >
                              Yes
                            </button>
                            <button
                              onClick={() => setDeleteConfirmId(null)}
                              disabled={isProcessing}
                              className="text-muted hover:text-foreground text-xs disabled:opacity-50"
                            >
                              No
                            </button>
                          </div>
                        ) : (
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
                                  onClick={() => setDeleteConfirmId(workspace.id)}
                                  disabled={isProcessing}
                                  className="text-muted rounded p-1.5 transition-colors hover:bg-white/10 hover:text-red-400 disabled:opacity-50"
                                  aria-label={`Delete workspace ${displayTitle}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>Delete permanently</TooltipContent>
                            </Tooltip>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
};
