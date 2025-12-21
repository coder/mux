import React from "react";
import { cn } from "@/common/lib/utils";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { ArchiveIcon, ArchiveRestoreIcon } from "./icons/ArchiveIcon";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { RuntimeBadge } from "./RuntimeBadge";
import { usePersistedState } from "@/browser/hooks/usePersistedState";

interface ArchivedWorkspacesProps {
  projectPath: string;
  projectName: string;
  workspaces: FrontendWorkspaceMetadata[];
  /** Called after a workspace is unarchived or deleted to refresh the list */
  onWorkspacesChanged?: () => void;
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
  const [expanded, setExpanded] = usePersistedState("archivedWorkspacesExpanded", true);
  const [processingIds, setProcessingIds] = React.useState<Set<string>>(new Set());
  const [deleteConfirmId, setDeleteConfirmId] = React.useState<string | null>(null);

  const archivedWorkspaces = workspaces.filter((w) => w.archived);

  if (archivedWorkspaces.length === 0) {
    return null;
  }

  const handleUnarchive = async (workspaceId: string) => {
    setProcessingIds((prev) => new Set(prev).add(workspaceId));
    try {
      const result = await unarchiveWorkspace(workspaceId);
      if (result.success) {
        // Select the workspace after unarchiving
        const workspace = archivedWorkspaces.find((w) => w.id === workspaceId);
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
    <div className="border-border mt-6 rounded-lg border">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="hover:bg-hover flex w-full items-center gap-2 rounded-t-lg px-4 py-3 text-left transition-colors"
      >
        <ArchiveIcon className="text-muted h-4 w-4" />
        <span className="text-foreground flex-1 font-medium">
          Archived Workspaces ({archivedWorkspaces.length})
        </span>
        {expanded ? (
          <ChevronDown className="text-muted h-4 w-4" />
        ) : (
          <ChevronRight className="text-muted h-4 w-4" />
        )}
      </button>

      {expanded && (
        <div className="border-border border-t">
          {archivedWorkspaces.map((workspace) => {
            const isProcessing = processingIds.has(workspace.id);
            const isDeleting = deleteConfirmId === workspace.id;
            const displayTitle = workspace.title ?? workspace.name;

            return (
              <div
                key={workspace.id}
                className={cn(
                  "border-border flex items-center gap-3 border-b px-4 py-3 last:border-b-0",
                  isProcessing && "opacity-50"
                )}
              >
                <RuntimeBadge runtimeConfig={workspace.runtimeConfig} isWorking={false} />
                <div className="min-w-0 flex-1">
                  <div className="text-foreground truncate text-sm font-medium">{displayTitle}</div>
                  <div className="text-muted text-xs">
                    Archived{" "}
                    {workspace.archivedAt
                      ? new Date(workspace.archivedAt).toLocaleDateString()
                      : "recently"}
                  </div>
                </div>

                {isDeleting ? (
                  <div className="flex items-center gap-2">
                    <span className="text-muted text-xs">Delete permanently?</span>
                    <button
                      onClick={() => void handleDelete(workspace.id)}
                      disabled={isProcessing}
                      className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setDeleteConfirmId(null)}
                      disabled={isProcessing}
                      className="text-muted hover:text-foreground text-xs disabled:opacity-50"
                    >
                      Cancel
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
      )}
    </div>
  );
};
