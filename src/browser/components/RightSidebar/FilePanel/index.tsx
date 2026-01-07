/**
 * FilePanel - File browser panel for the right sidebar
 *
 * Displays a file tree on the right and file content on the left (IDE-style layout).
 * Content is syntax highlighted using Shiki.
 */

import React from "react";
import { useAPI } from "@/browser/contexts/API";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getFilePanelExpandStateKey,
  getFilePanelSelectedFileKey,
} from "@/common/constants/storage";
import { cn } from "@/common/lib/utils";
import { FileIcon } from "@/browser/components/FileIcon";
import { highlightCode } from "@/browser/utils/highlighting/highlightWorkerClient";
import { useTheme } from "@/browser/contexts/ThemeContext";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";

interface FilePanelProps {
  workspaceId: string;
}

/** Tree node component for rendering file/folder entries */
const TreeNode: React.FC<{
  node: FileTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  expandStateMap: Record<string, boolean>;
  setExpandStateMap: (
    value: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)
  ) => void;
}> = ({ node, depth, selectedPath, onSelectFile, expandStateMap, setExpandStateMap }) => {
  const hasManualState = node.path in expandStateMap;
  const isOpen = hasManualState ? expandStateMap[node.path] : depth < 2;

  const setIsOpen = (open: boolean) => {
    setExpandStateMap((prev) => ({
      ...prev,
      [node.path]: open,
    }));
  };

  const handleClick = (e: React.MouseEvent) => {
    if (node.isDirectory) {
      const target = e.target as HTMLElement;
      const isToggleClick = target.closest("[data-toggle]");
      if (isToggleClick) {
        setIsOpen(!isOpen);
      } else {
        setIsOpen(!isOpen);
      }
    } else {
      onSelectFile(node.path);
    }
  };

  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  };

  const isSelected = selectedPath === node.path;

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
            <span className="text-muted flex-1">{node.name || "/"}</span>
          </>
        ) : (
          <>
            <FileIcon fileName={node.name} filePath={node.path} className="shrink-0" />
            <span className="text-foreground flex-1">{node.name}</span>
          </>
        )}
      </div>

      {node.isDirectory &&
        isOpen &&
        node.children.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            expandStateMap={expandStateMap}
            setExpandStateMap={setExpandStateMap}
          />
        ))}
    </>
  );
};

/** File content viewer with syntax highlighting */
const FileContentViewer: React.FC<{
  workspaceId: string;
  filePath: string;
  onClose: () => void;
}> = ({ workspaceId, filePath, onClose }) => {
  const api = useAPI();
  const { theme } = useTheme();
  const [content, setContent] = React.useState<string | null>(null);
  const [highlightedContent, setHighlightedContent] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [truncated, setTruncated] = React.useState(false);
  const [totalSize, setTotalSize] = React.useState(0);

  // Load file content
  React.useEffect(() => {
    if (api.status !== "connected" && api.status !== "degraded") return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    api.api.workspace
      .readFile({ workspaceId, path: filePath })
      .then(async (result) => {
        if (cancelled) return;

        if (!result.success) {
          setError(result.error);
          setLoading(false);
          return;
        }

        setContent(result.data.content);
        setTruncated(result.data.truncated);
        setTotalSize(result.data.totalSize);

        // Highlight the content
        try {
          const isDarkTheme = theme === "dark" || theme === "solarized-dark";
          const highlighted = await highlightCode(
            result.data.content,
            result.data.language,
            isDarkTheme ? "dark" : "light"
          );
          if (!cancelled) {
            setHighlightedContent(highlighted);
          }
        } catch {
          // Fallback to plain text on highlight failure
          if (!cancelled) {
            setHighlightedContent(null);
          }
        }

        setLoading(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, filePath, theme]);

  const fileName = filePath.split("/").pop() ?? filePath;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="border-border-light flex items-center gap-2 border-b px-3 py-1.5">
        <FileIcon fileName={fileName} filePath={filePath} className="shrink-0" />
        <span className="text-foreground flex-1 truncate text-xs font-medium" title={filePath}>
          {fileName}
        </span>
        {truncated && (
          <span className="text-warning text-[10px]" title={`File truncated (${totalSize} bytes)`}>
            truncated
          </span>
        )}
        <button
          onClick={onClose}
          className="text-muted hover:text-foreground text-xs transition-colors"
          title="Close file"
        >
          ✕
        </button>
      </div>

      {/* Content */}
      <div className="font-monospace flex-1 overflow-auto text-xs">
        {loading ? (
          <div className="text-muted p-4 text-center">Loading...</div>
        ) : error ? (
          <div className="text-warning p-4 text-center">{error}</div>
        ) : highlightedContent ? (
          <div
            className="file-content-highlighted p-2"
            dangerouslySetInnerHTML={{ __html: highlightedContent }}
          />
        ) : (
          <pre className="text-foreground p-2 whitespace-pre-wrap">{content}</pre>
        )}
      </div>
    </div>
  );
};

export const FilePanel: React.FC<FilePanelProps> = ({ workspaceId }) => {
  const api = useAPI();

  // File tree state
  const [fileTree, setFileTree] = React.useState<FileTreeNode | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Selected file (persisted per workspace)
  const [selectedFile, setSelectedFile] = usePersistedState<string | null>(
    getFilePanelSelectedFileKey(workspaceId),
    null
  );

  // Expand state for tree (persisted per workspace)
  const [expandStateMap, setExpandStateMap] = usePersistedState<Record<string, boolean>>(
    getFilePanelExpandStateKey(workspaceId),
    {},
    { listener: true }
  );

  // Load file tree
  React.useEffect(() => {
    if (api.status !== "connected" && api.status !== "degraded") return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    api.api.workspace
      .listFiles({ workspaceId })
      .then((result) => {
        if (cancelled) return;

        if (!result.success) {
          setError(result.error);
          setLoading(false);
          return;
        }

        setFileTree(result.data);
        setLoading(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, workspaceId]);

  const handleSelectFile = (path: string) => {
    setSelectedFile(path);
  };

  const handleCloseFile = () => {
    setSelectedFile(null);
  };

  return (
    <div className="flex h-full">
      {/* File content viewer (left side) */}
      {selectedFile && (
        <div className="border-border-light flex-1 overflow-hidden border-r">
          <FileContentViewer
            workspaceId={workspaceId}
            filePath={selectedFile}
            onClose={handleCloseFile}
          />
        </div>
      )}

      {/* File tree (right side) */}
      <div
        className={cn(
          "flex flex-col overflow-hidden",
          selectedFile ? "w-[200px] shrink-0" : "flex-1"
        )}
      >
        {/* Header */}
        <div className="border-border-light text-muted font-primary flex items-center gap-2 border-b px-2 py-1 text-[11px]">
          <span>Files</span>
        </div>

        {/* Tree content */}
        <div className="font-monospace min-h-0 flex-1 overflow-y-auto px-1 py-1 text-[11px]">
          {loading ? (
            <div className="text-muted py-5 text-center">Loading files...</div>
          ) : error ? (
            <div className="text-warning py-5 text-center">{error}</div>
          ) : fileTree ? (
            fileTree.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={0}
                selectedPath={selectedFile}
                onSelectFile={handleSelectFile}
                expandStateMap={expandStateMap}
                setExpandStateMap={setExpandStateMap}
              />
            ))
          ) : (
            <div className="text-muted py-5 text-center">No files in workspace</div>
          )}
        </div>
      </div>
    </div>
  );
};
