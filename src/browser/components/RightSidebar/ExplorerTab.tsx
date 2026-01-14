/**
 * ExplorerTab - VS Code-style file explorer tree view.
 *
 * Features:
 * - Lazy-load directories on expand
 * - Auto-refresh on file-modifying tool completion (debounced)
 * - Toolbar with Refresh and Collapse All buttons
 */

import React from "react";
import { useAPI } from "@/browser/contexts/API";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderClosed,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import { FileIcon } from "../FileIcon";
import { cn } from "@/common/lib/utils";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

interface ExplorerTabProps {
  workspaceId: string;
  workspacePath: string;
}

interface ExplorerState {
  entries: Map<string, FileTreeNode[]>; // relativePath -> children
  expanded: Set<string>;
  loading: Set<string>;
  error: string | null;
}

const DEBOUNCE_MS = 2000;
const INDENT_PX = 12;

export const ExplorerTab: React.FC<ExplorerTabProps> = (props) => {
  const { api } = useAPI();

  const [state, setState] = React.useState<ExplorerState>({
    entries: new Map(),
    expanded: new Set(),
    loading: new Set(["__root__"]),
    error: null,
  });

  // Track if we've done initial load
  const initialLoadRef = React.useRef(false);

  // Fetch a directory's contents and return the entries (for recursive expand)
  const fetchDirectory = React.useCallback(
    async (relativePath: string): Promise<FileTreeNode[] | null> => {
      const key = relativePath || "__root__";

      setState((prev) => ({
        ...prev,
        loading: new Set(prev.loading).add(key),
        error: null,
      }));

      try {
        if (!api) return null;
        const result = await api.general.listWorkspaceDirectory({
          workspacePath: props.workspacePath,
          relativePath: relativePath || undefined,
        });

        if (!result.success) {
          setState((prev) => ({
            ...prev,
            loading: new Set([...prev.loading].filter((k) => k !== key)),
            error: result.error,
          }));
          return null;
        }

        setState((prev) => {
          const newEntries = new Map(prev.entries);
          newEntries.set(key, result.data);
          return {
            ...prev,
            entries: newEntries,
            loading: new Set([...prev.loading].filter((k) => k !== key)),
          };
        });

        return result.data;
      } catch (err) {
        setState((prev) => ({
          ...prev,
          loading: new Set([...prev.loading].filter((k) => k !== key)),
          error: err instanceof Error ? err.message : String(err),
        }));
        return null;
      }
    },
    [api, props.workspacePath]
  );

  // Initial load
  React.useEffect(() => {
    if (!initialLoadRef.current) {
      initialLoadRef.current = true;
      void fetchDirectory("");
    }
  }, [fetchDirectory]);

  // Subscribe to file-modifying tool events and debounce refresh
  React.useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = workspaceStore.subscribeFileModifyingTool(() => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        // Refresh root and all expanded directories
        const pathsToRefresh = ["", ...state.expanded];
        void Promise.all(pathsToRefresh.map((p) => fetchDirectory(p)));
      }, DEBOUNCE_MS);
    }, props.workspaceId);

    return () => {
      unsubscribe();
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [props.workspaceId, state.expanded, fetchDirectory]);

  // Toggle expand/collapse
  const toggleExpand = (node: FileTreeNode) => {
    if (!node.isDirectory) return;

    const key = node.path;

    setState((prev) => {
      const newExpanded = new Set(prev.expanded);

      if (newExpanded.has(key)) {
        newExpanded.delete(key);
        return { ...prev, expanded: newExpanded };
      }

      newExpanded.add(key);

      // Fetch if not already loaded
      if (!prev.entries.has(key)) {
        void fetchDirectory(key);
      }

      return { ...prev, expanded: newExpanded };
    });
  };

  // Refresh all expanded paths
  const handleRefresh = () => {
    const pathsToRefresh = ["", ...state.expanded];
    void Promise.all(pathsToRefresh.map((p) => fetchDirectory(p)));
  };

  // Collapse all
  const handleCollapseAll = () => {
    setState((prev) => ({
      ...prev,
      expanded: new Set(),
    }));
  };

  // Expand all recursively (skip gitignored directories)
  const handleExpandAll = async () => {
    const allDirs: string[] = [];
    const entriesCache = new Map(state.entries);

    // Recursively fetch and collect all non-ignored directories
    const expandRecursively = async (parentKey: string): Promise<void> => {
      let entries = entriesCache.get(parentKey);

      // Fetch if not in cache
      if (!entries) {
        const fetched = await fetchDirectory(parentKey === "__root__" ? "" : parentKey);
        if (fetched) {
          entries = fetched;
          entriesCache.set(parentKey, entries);
        }
      }

      if (!entries) return;

      // Process children in parallel
      const childPromises: Array<Promise<void>> = [];
      for (const entry of entries) {
        if (entry.isDirectory && !entry.ignored) {
          allDirs.push(entry.path);
          childPromises.push(expandRecursively(entry.path));
        }
      }

      await Promise.all(childPromises);
    };

    await expandRecursively("__root__");

    setState((prev) => ({
      ...prev,
      expanded: new Set(allDirs),
    }));
  };

  const hasExpandedDirs = state.expanded.size > 0;

  // Render a tree node recursively
  const renderNode = (node: FileTreeNode, depth: number): React.ReactNode => {
    const key = node.path;
    const isExpanded = state.expanded.has(key);
    const isLoading = state.loading.has(key);
    const children = state.entries.get(key) ?? [];
    const isIgnored = node.ignored === true;

    return (
      <div key={key}>
        <button
          type="button"
          className={cn(
            "flex w-full cursor-pointer items-center gap-1 px-2 py-0.5 text-left text-sm hover:bg-accent/50",
            "focus:bg-accent/50 focus:outline-none",
            isIgnored && "opacity-50"
          )}
          style={{ paddingLeft: `${8 + depth * INDENT_PX}px` }}
          onClick={() => (node.isDirectory ? toggleExpand(node) : undefined)}
        >
          {node.isDirectory ? (
            <>
              {isLoading ? (
                <RefreshCw className="text-muted h-3 w-3 shrink-0 animate-spin" />
              ) : isExpanded ? (
                <ChevronDown className="text-muted h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="text-muted h-3 w-3 shrink-0" />
              )}
              {isExpanded ? (
                <FolderOpen className="h-4 w-4 shrink-0 text-[#dcb67a]" />
              ) : (
                <FolderClosed className="h-4 w-4 shrink-0 text-[#dcb67a]" />
              )}
            </>
          ) : (
            <>
              <span className="w-3 shrink-0" />
              <FileIcon fileName={node.name} style={{ fontSize: 18 }} className="h-4 w-4" />
            </>
          )}
          <span className="truncate">{node.name}</span>
        </button>

        {node.isDirectory && isExpanded && (
          <div>{children.map((child) => renderNode(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  const rootEntries = state.entries.get("__root__") ?? [];
  const isRootLoading = state.loading.has("__root__");

  // Shorten workspace path for display (replace home dir with ~, show last 2 segments if still long)
  const shortenPath = (fullPath: string): string => {
    // Replace home directory with ~
    const homeDir = "/home/";
    let shortened = fullPath;
    if (shortened.startsWith(homeDir)) {
      const afterHome = shortened.slice(homeDir.length);
      const slashIdx = afterHome.indexOf("/");
      if (slashIdx !== -1) {
        shortened = "~" + afterHome.slice(slashIdx);
      } else {
        shortened = "~";
      }
    }
    return shortened;
  };

  const displayPath = shortenPath(props.workspacePath);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="border-border-light flex items-center gap-1 border-b px-2 py-1">
        <FolderOpen className="h-4 w-4 shrink-0 text-[#dcb67a]" />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{displayPath}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{props.workspacePath}</TooltipContent>
        </Tooltip>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted hover:bg-accent/50 hover:text-foreground rounded p-1"
                onClick={handleRefresh}
                disabled={isRootLoading}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", isRootLoading && "animate-spin")} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Refresh</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted hover:bg-accent/50 hover:text-foreground rounded p-1"
                onClick={hasExpandedDirs ? handleCollapseAll : handleExpandAll}
              >
                {hasExpandedDirs ? (
                  <ChevronsDownUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronsUpDown className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {hasExpandedDirs ? "Collapse All" : "Expand All"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {state.error && <div className="text-destructive px-3 py-2 text-sm">{state.error}</div>}
        {isRootLoading && rootEntries.length === 0 ? (
          <div className="flex items-center justify-center py-4">
            <RefreshCw className="text-muted h-5 w-5 animate-spin" />
          </div>
        ) : (
          rootEntries.map((node) => renderNode(node, 0))
        )}
        {!isRootLoading && rootEntries.length === 0 && !state.error && (
          <div className="text-muted px-3 py-2 text-sm">No files found</div>
        )}
      </div>
    </div>
  );
};
