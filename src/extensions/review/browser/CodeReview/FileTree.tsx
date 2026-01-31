/**
 * FileTree - Displays file hierarchy with diff statistics
 */

import React from "react";
import { extractNewPath, type FileTreeNode } from "@/common/utils/git/numstatParser";
import type { FileChangeType } from "@/common/types/review";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { getFileTreeExpandStateKey } from "@/common/constants/storage";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/ui/tooltip";
import { FileIcon } from "@/browser/components/FileIcon";

/**
 * Compute read status for a directory by recursively checking all descendant files
 * Returns "fully-read" if all files are fully read, "unknown" if any file has unknown status, null otherwise
 */
function computeDirectoryReadStatus(
  node: FileTreeNode,
  getFileReadStatus?: (filePath: string) => { total: number; read: number } | null
): "fully-read" | "unknown" | null {
  if (!node.isDirectory || !getFileReadStatus) return null;

  let hasUnknown = false;
  let fileCount = 0;
  let fullyReadCount = 0;

  const checkNode = (n: FileTreeNode) => {
    if (n.isDirectory) {
      // Recurse into children
      n.children.forEach(checkNode);
    } else {
      // Check file status
      fileCount++;
      const status = getFileReadStatus(extractNewPath(n.path));
      if (status === null) {
        // Some diff entries (renames, binary changes, mode-only edits) have no hunks.
        // Only treat this as "unknown" when numstat indicates there's actual +/− content.
        if ((n.stats?.additions ?? 0) > 0 || (n.stats?.deletions ?? 0) > 0) {
          hasUnknown = true;
        }
      } else if (status.read === status.total && status.total > 0) {
        fullyReadCount++;
      }
    }
  };

  checkNode(node);

  // If any file has unknown state, directory is unknown
  if (hasUnknown) return "unknown";

  // If all files are fully read, directory is fully read
  if (fileCount > 0 && fullyReadCount === fileCount) return "fully-read";

  // Otherwise, directory has partial/no read state
  return null;
}

function getFileChangeBadge(
  changeType: FileChangeType,
  oldPath?: string
): {
  label: string;
  className: string;
  title: string;
} {
  switch (changeType) {
    case "added":
      return { label: "A", className: "text-success-light", title: "Added" };
    case "deleted":
      return { label: "D", className: "text-danger", title: "Deleted" };
    case "renamed":
      return {
        label: "R",
        className: "text-muted",
        title: oldPath ? `Renamed from ${oldPath}` : "Renamed",
      };
    case "modified":
      return {
        label: "M",
        className: "text-warning-light",
        title: "Modified",
      };
  }
}

const TreeNodeContent: React.FC<{
  node: FileTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelectFile: (path: string | null) => void;
  getFileReadStatus?: (filePath: string) => { total: number; read: number } | null;
  expandStateMap: Record<string, boolean>;
  setExpandStateMap: (
    value: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)
  ) => void;
}> = ({
  node,
  depth,
  selectedPath,
  onSelectFile,
  getFileReadStatus,
  expandStateMap,
  setExpandStateMap,
}) => {
  // Check if user has manually set expand state for this directory
  const hasManualState = node.path in expandStateMap;
  const isOpen = hasManualState ? expandStateMap[node.path] : depth < 2; // Default: auto-expand first 2 levels

  const setIsOpen = (open: boolean) => {
    setExpandStateMap((prev) => ({
      ...prev,
      [node.path]: open,
    }));
  };

  const handleClick = (e: React.MouseEvent) => {
    if (node.isDirectory) {
      // Check if clicked on the toggle icon area (first 20px)
      const target = e.target as HTMLElement;
      const isToggleClick = target.closest("[data-toggle]");

      if (isToggleClick) {
        // Just toggle expansion
        setIsOpen(!isOpen);
      } else {
        // Clicking on folder name/stats selects the folder for filtering
        // Use full path (with prefix) for selection
        onSelectFile(selectedPath === node.path ? null : node.path);
      }
    } else {
      // Toggle selection: if already selected, clear filter
      // Use full path (with prefix) for selection
      onSelectFile(selectedPath === node.path ? null : node.path);
    }
  };

  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  };

  const canonicalFilePath = node.isDirectory ? node.path : extractNewPath(node.path);
  const fallbackFileName = canonicalFilePath.split("/").pop() ?? "";
  const fileNameForIcon = fallbackFileName;
  const isSelected = selectedPath === node.path;

  const changeType = !node.isDirectory ? (node.stats?.changeType ?? "modified") : null;
  const isDeletedFile = changeType === "deleted";
  const isRenamedFile = changeType === "renamed" && !!node.stats?.oldPath;
  const oldFileName = node.stats?.oldPath?.split("/").pop() ?? node.stats?.oldPath ?? "";

  // Compute read status for files and directories
  let isFullyRead = false;
  let isUnknownState = false;

  if (node.isDirectory) {
    const dirStatus = computeDirectoryReadStatus(node, getFileReadStatus);
    isFullyRead = dirStatus === "fully-read";
    isUnknownState = dirStatus === "unknown";
  } else if (getFileReadStatus) {
    const readStatus = getFileReadStatus(canonicalFilePath);
    isFullyRead = readStatus ? readStatus.read === readStatus.total && readStatus.total > 0 : false;

    // Some diff entries (renames, binary changes, mode-only edits) have no hunks.
    // Only treat this as "unknown" when numstat indicates there's actual +/− content.
    isUnknownState =
      readStatus === null && ((node.stats?.additions ?? 0) > 0 || (node.stats?.deletions ?? 0) > 0);
  }

  const iconOpacity = isFullyRead ? 0.45 : isUnknownState && !isFullyRead ? 0.7 : 1;

  const fileChangeBadge =
    !node.isDirectory && node.stats
      ? getFileChangeBadge(node.stats.changeType ?? "modified", node.stats.oldPath)
      : null;

  return (
    <>
      <div
        className={cn(
          "cursor-pointer select-none flex items-center gap-1.5 rounded py-0.5 px-1.5",
          isSelected ? "bg-code-keyword-overlay" : "bg-transparent hover:bg-white/5"
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={handleClick}
      >
        {node.isDirectory ? (
          <>
            <span
              className="text-muted inline-flex h-3 w-3 shrink-0 items-center justify-center text-[8px] transition-transform duration-200"
              style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }}
              data-toggle
              onClick={handleToggleClick}
            >
              ▶
            </span>
            <span
              className={cn(
                "flex-1",
                isFullyRead &&
                  "text-dim line-through [text-decoration-color:var(--color-read)] [text-decoration-thickness:2px]",
                isUnknownState && !isFullyRead && "text-dim",
                !isFullyRead && !isUnknownState && "text-muted"
              )}
            >
              {node.name || "/"}
            </span>
            {node.totalStats &&
              (node.totalStats.additions > 0 || node.totalStats.deletions > 0) && (
                <span
                  className="flex gap-2 text-[11px] opacity-70"
                  style={{ color: isOpen ? "var(--color-dim)" : "inherit" }}
                >
                  {node.totalStats.additions > 0 &&
                    (isOpen ? (
                      <span>+{node.totalStats.additions}</span>
                    ) : (
                      <span className="text-success-light">+{node.totalStats.additions}</span>
                    ))}
                  {node.totalStats.deletions > 0 &&
                    (isOpen ? (
                      <span>-{node.totalStats.deletions}</span>
                    ) : (
                      <span className="text-warning-light">-{node.totalStats.deletions}</span>
                    ))}
                </span>
              )}
          </>
        ) : (
          <>
            <FileIcon
              fileName={fileNameForIcon}
              filePath={node.path}
              className="shrink-0"
              style={{ opacity: iconOpacity }}
            />
            <span
              className={cn(
                "flex-1",
                isDeletedFile && "line-through",
                isFullyRead &&
                  "text-dim line-through [text-decoration-color:var(--color-read)] [text-decoration-thickness:2px]",
                isUnknownState && !isFullyRead && "text-dim",
                !isFullyRead && !isUnknownState && "text-foreground"
              )}
            >
              {isRenamedFile ? (
                <>
                  <span className="text-muted">{oldFileName}</span>
                  <span className="text-muted">{" -> "}</span>
                  <span>{fallbackFileName}</span>
                </>
              ) : (
                node.name
              )}
            </span>
            <span className="ml-auto flex items-center gap-2 text-[11px]">
              {node.stats?.additions ? (
                <span className="text-success-light">+{node.stats.additions}</span>
              ) : null}
              {node.stats?.deletions ? (
                <span className="text-warning-light">-{node.stats.deletions}</span>
              ) : null}
              {fileChangeBadge ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn("shrink-0 font-semibold", fileChangeBadge.className)}
                      style={{ opacity: iconOpacity }}
                    >
                      {fileChangeBadge.label}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="left" align="center">
                    {fileChangeBadge.title}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </span>
          </>
        )}
      </div>

      {node.isDirectory &&
        isOpen &&
        node.children.map((child) => (
          <TreeNodeContent
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            getFileReadStatus={getFileReadStatus}
            expandStateMap={expandStateMap}
            setExpandStateMap={setExpandStateMap}
          />
        ))}
    </>
  );
};

interface FileTreeExternalProps {
  root: FileTreeNode | null;
  selectedPath: string | null;
  onSelectFile: (path: string | null) => void;
  isLoading?: boolean;
  getFileReadStatus?: (filePath: string) => { total: number; read: number } | null;
  workspaceId: string;
}

export const FileTree: React.FC<FileTreeExternalProps> = ({
  root,
  selectedPath,
  onSelectFile,
  isLoading = false,
  getFileReadStatus,
  workspaceId,
}) => {
  // Use persisted state for expand/collapse per workspace (lifted to parent to avoid O(n) re-renders)
  const [expandStateMap, setExpandStateMap] = usePersistedState<Record<string, boolean>>(
    getFileTreeExpandStateKey(workspaceId),
    {},
    { listener: true }
  );

  // Extract display name for filter indicator
  const filterDisplayName = selectedPath ? (selectedPath.split("/").pop() ?? selectedPath) : null;

  return (
    <>
      <div className="border-border-light text-muted font-primary flex items-center gap-2 border-b px-2 py-1 text-[11px]">
        <span>Files</span>
        {selectedPath && (
          <button
            className="bg-code-keyword-overlay text-foreground hover:bg-code-keyword-overlay/80 ml-auto flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors"
            onClick={() => onSelectFile(null)}
            title={`Filtering: ${selectedPath}\nClick to clear`}
          >
            <span className="max-w-[120px] truncate">{filterDisplayName}</span>
            <span className="text-muted">✕</span>
          </button>
        )}
      </div>
      <div className="font-monospace min-h-0 flex-1 overflow-y-auto px-1 py-1 text-[11px]">
        {isLoading && !root ? (
          <div className="text-muted py-5 text-center">Loading file tree...</div>
        ) : root ? (
          root.children.map((child) => (
            <TreeNodeContent
              key={child.path}
              node={child}
              depth={0}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              getFileReadStatus={getFileReadStatus}
              expandStateMap={expandStateMap}
              setExpandStateMap={setExpandStateMap}
            />
          ))
        ) : (
          <div className="text-muted py-5 text-center">No files changed</div>
        )}
      </div>
    </>
  );
};
