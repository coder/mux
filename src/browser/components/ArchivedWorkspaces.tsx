import React from "react";
import { cn } from "@/common/lib/utils";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { Trash2, Search } from "lucide-react";
import { ArchiveIcon, ArchiveRestoreIcon } from "./icons/ArchiveIcon";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { RuntimeBadge } from "./RuntimeBadge";

interface ArchivedWorkspacesProps {
  projectPath: string;
  projectName: string;
  workspaces: FrontendWorkspaceMetadata[];
  /** Called after a workspace is unarchived or deleted to refresh the list */
  onWorkspacesChanged?: () => void;
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

  return (
    <div className="border-border rounded-lg border">
      {/* Header - not collapsible */}
      <div className="flex items-center gap-2 px-4 py-3">
        <ArchiveIcon className="text-muted h-4 w-4" />
        <span className="text-foreground flex-1 font-medium">
          Archived Workspaces ({workspaces.length})
        </span>
      </div>

      <div className="border-border border-t">
        {/* Search input */}
        {workspaces.length > 3 && (
          <div className="border-border border-b px-4 py-2">
            <div className="relative">
              <Search className="text-muted pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search archived workspaces..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-bg-dark placeholder:text-muted text-foreground w-full rounded border border-transparent py-1.5 pl-8 pr-3 text-sm focus:border-border-light focus:outline-none"
              />
            </div>
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
                  const displayTitle = workspace.title ?? workspace.name;

                  return (
                    <div
                      key={workspace.id}
                      className={cn(
                        "border-border flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0",
                        isProcessing && "opacity-50"
                      )}
                    >
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
  );
};
