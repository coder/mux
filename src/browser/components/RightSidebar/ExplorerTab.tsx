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
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FolderClosed,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import { FileIcon } from "../FileIcon";
import { cn } from "@/common/lib/utils";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  validateRelativePath,
  buildListDirScript,
  buildGitIgnoredScript,
  buildGitCheckIgnoreScript,
  parseLsOutput,
  parseGitStatus,
  parseGitCheckIgnoreOutput,
  type GitStatusResult,
} from "@/browser/utils/fileExplorer";

interface ExplorerTabProps {
  workspaceId: string;
  workspacePath: string;
  /** Callback when user clicks a file (not directory) */
  onOpenFile?: (relativePath: string) => void;
}

interface ExplorerState {
  entries: Map<string, FileTreeNode[]>; // relativePath -> children
  expanded: Set<string>;
  loading: Set<string>;
  error: string | null;
  gitStatus: GitStatusResult; // cached from root fetch
  ignoredDirs: Set<string>; // dirs confirmed ignored via git check-ignore
  checkedDirPaths: Set<string>; // dirs we've already checked (cache)
}

const DEBOUNCE_MS = 2000;
const INDENT_PX = 12;

// Cache key builders
const entriesCacheKey = (workspaceId: string) => `explorer:entries:${workspaceId}`;
const expandedCacheKey = (workspaceId: string) => `explorer:expanded:${workspaceId}`;

export const ExplorerTab: React.FC<ExplorerTabProps> = (props) => {
  const { api } = useAPI();

  // Persist expanded folders across tab switches
  const [expandedPaths, setExpandedPaths] = usePersistedState<string[]>(
    expandedCacheKey(props.workspaceId),
    [],
    { listener: true }
  );
  const expandedSet = React.useMemo(() => new Set(expandedPaths), [expandedPaths]);

  // Initialize entries from cache
  const [state, setState] = React.useState<ExplorerState>(() => {
    const cached = readPersistedState<Record<string, FileTreeNode[]>>(
      entriesCacheKey(props.workspaceId),
      {}
    );
    return {
      entries: new Map(Object.entries(cached)),
      expanded: new Set(), // managed by usePersistedState above
      loading: new Set(), // starts empty, set when fetch begins
      error: null,
      gitStatus: { ignored: new Set(), modified: new Set(), untracked: new Set() },
      ignoredDirs: new Set(),
      checkedDirPaths: new Set(),
    };
  });

  // Persist entries when they change
  React.useEffect(() => {
    const obj = Object.fromEntries(state.entries);
    updatePersistedState(entriesCacheKey(props.workspaceId), obj, {});
  }, [state.entries, props.workspaceId]);

  // Track if we've done initial load
  const initialLoadRef = React.useRef(false);

  // Fetch a directory's contents and return the entries (for recursive expand)
  const fetchDirectory = React.useCallback(
    async (relativePath: string, suppressErrors = false): Promise<FileTreeNode[] | null> => {
      if (!api) return null;

      const key = relativePath; // empty string = root directory

      // Validate path before making request
      const pathError = validateRelativePath(relativePath);
      if (pathError) {
        if (!suppressErrors) {
          setState((prev) => ({ ...prev, error: pathError }));
        }
        return null;
      }

      setState((prev) => ({
        ...prev,
        loading: new Set(prev.loading).add(key),
        error: null,
      }));

      try {
        // Run ls (and git status only for root)
        const isRoot = relativePath === "";
        const lsPromise = api.workspace.executeBash({
          workspaceId: props.workspaceId,
          script: buildListDirScript(relativePath),
        });
        const gitPromise = isRoot
          ? api.workspace.executeBash({
              workspaceId: props.workspaceId,
              script: buildGitIgnoredScript(""),
            })
          : null;

        const [lsResult, gitResult] = await Promise.all([lsPromise, gitPromise]);

        // Check for ORPC-level failure
        if (!lsResult.success) {
          // Remove from expanded set (dir may have been deleted)
          setExpandedPaths((prev) => prev.filter((p) => p !== key));
          setState((prev) => {
            const newEntries = new Map(prev.entries);
            newEntries.delete(key);
            return {
              ...prev,
              entries: newEntries,
              loading: new Set([...prev.loading].filter((k) => k !== key)),
              error: suppressErrors ? prev.error : lsResult.error,
            };
          });
          return null;
        }

        // Check for bash command failure (non-zero exit)
        if (!lsResult.data.success) {
          const errorMessage = lsResult.data.error || "Failed to list directory";
          // On failure, remove from expanded set (dir may have been deleted)
          setExpandedPaths((prev) => prev.filter((p) => p !== key));
          setState((prev) => {
            // Remove stale entries
            const newEntries = new Map(prev.entries);
            newEntries.delete(key);
            return {
              ...prev,
              entries: newEntries,
              loading: new Set([...prev.loading].filter((k) => k !== key)),
              // Only set error for root or if not suppressing
              error: suppressErrors ? prev.error : errorMessage,
            };
          });
          return null;
        }

        // Parse ls output into nodes
        const nodes = parseLsOutput(lsResult.data.output, relativePath);

        // Update git status cache on root fetch
        let newGitStatus: GitStatusResult | null = null;
        if (isRoot && gitResult?.success && gitResult.data.success) {
          newGitStatus = parseGitStatus(gitResult.data.output, "");
        }

        // Collect directory paths that need ignore checking:
        // - Directories we haven't checked yet (or on root refresh, re-check all)
        // - Not already known to be ignored from git status
        const dirsToCheck: string[] = [];
        setState((prev) => {
          const gitStatus = newGitStatus ?? prev.gitStatus;
          // On root fetch, clear checkedDirPaths to re-check everything
          // Keep ignoredDirs intact to avoid flicker - we'll update after check-ignore
          const checkedDirPaths = isRoot ? new Set<string>() : prev.checkedDirPaths;

          for (const node of nodes) {
            if (
              node.isDirectory &&
              !checkedDirPaths.has(node.path) &&
              !gitStatus.ignored.has(node.path)
            ) {
              dirsToCheck.push(node.path);
            }
          }

          const newEntries = new Map(prev.entries);
          newEntries.set(key, nodes);

          // Apply ignored status from git status and ignoredDirs cache
          for (const node of nodes) {
            if (gitStatus.ignored.has(node.path) || prev.ignoredDirs.has(node.path)) {
              node.ignored = true;
            }
          }

          return {
            ...prev,
            entries: newEntries,
            loading: new Set([...prev.loading].filter((k) => k !== key)),
            gitStatus,
            checkedDirPaths,
          };
        });

        // Run git check-ignore for unchecked directories (if any)
        if (dirsToCheck.length > 0) {
          const checkIgnoreResult = await api.workspace.executeBash({
            workspaceId: props.workspaceId,
            script: buildGitCheckIgnoreScript(dirsToCheck),
          });

          if (checkIgnoreResult.success && checkIgnoreResult.data.success) {
            const newIgnoredDirs = parseGitCheckIgnoreOutput(checkIgnoreResult.data.output);

            setState((prev) => {
              // Mark all checked paths as checked
              const checkedDirPaths = new Set(prev.checkedDirPaths);
              for (const path of dirsToCheck) {
                checkedDirPaths.add(path);
              }

              // Add newly discovered ignored dirs to cache
              // (dirsToCheck already excludes gitStatus.ignored, so no conflict)
              const ignoredDirs = new Set(prev.ignoredDirs);
              for (const path of newIgnoredDirs) {
                ignoredDirs.add(path);
              }

              // Update nodes in entries - only set ignored=true, never false
              // (gitStatus.ignored is authoritative, check-ignore is supplemental)
              const newEntries = new Map(prev.entries);
              const existingNodes = newEntries.get(key);
              if (existingNodes) {
                for (const node of existingNodes) {
                  if (node.isDirectory && newIgnoredDirs.has(node.path)) {
                    node.ignored = true;
                  }
                }
              }

              return { ...prev, checkedDirPaths, ignoredDirs, entries: newEntries };
            });
          }
        }

        return nodes;
      } catch (err) {
        // On error, remove from expanded set
        setExpandedPaths((prev) => prev.filter((p) => p !== key));
        setState((prev) => {
          const newEntries = new Map(prev.entries);
          newEntries.delete(key);
          return {
            ...prev,
            entries: newEntries,
            loading: new Set([...prev.loading].filter((k) => k !== key)),
            error: suppressErrors ? prev.error : err instanceof Error ? err.message : String(err),
          };
        });
        return null;
      }
    },
    [api, props.workspaceId, setExpandedPaths]
  );

  // Initial load - retry when api becomes available
  // Also fetch expanded directories from cache
  React.useEffect(() => {
    if (!api) return;
    if (!initialLoadRef.current) {
      initialLoadRef.current = true;
      void fetchDirectory("");
      // Fetch expanded directories from persisted state (background refresh)
      for (const p of expandedSet) {
        void fetchDirectory(p, true); // suppress errors - folder may have been deleted
      }
    }
  }, [api, fetchDirectory, expandedSet]);

  // Subscribe to file-modifying tool events and debounce refresh
  React.useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = workspaceStore.subscribeFileModifyingTool(() => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        // Refresh root and all expanded directories
        // Suppress errors for non-root paths (dir may have been deleted)
        void fetchDirectory("");
        for (const p of expandedSet) {
          void fetchDirectory(p, true);
        }
      }, DEBOUNCE_MS);
    }, props.workspaceId);

    return () => {
      unsubscribe();
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [props.workspaceId, expandedSet, fetchDirectory]);

  // Toggle expand/collapse
  const toggleExpand = (node: FileTreeNode) => {
    if (!node.isDirectory) return;

    const key = node.path;

    if (expandedSet.has(key)) {
      setExpandedPaths((prev) => prev.filter((p) => p !== key));
    } else {
      setExpandedPaths((prev) => [...prev, key]);
      // Always fetch when expanding to ensure fresh data
      void fetchDirectory(key);
    }
  };

  // Refresh all expanded paths
  const handleRefresh = () => {
    const pathsToRefresh = ["", ...expandedSet];
    void Promise.all(pathsToRefresh.map((p) => fetchDirectory(p)));
  };

  // Collapse all
  const handleCollapseAll = () => {
    setExpandedPaths([]);
  };

  const hasExpandedDirs = expandedSet.size > 0;

  // Render a tree node recursively
  const renderNode = (node: FileTreeNode, depth: number): React.ReactNode => {
    const key = node.path;
    const isExpanded = expandedSet.has(key);
    const isLoading = state.loading.has(key);
    const children = state.entries.get(key) ?? [];
    // Check both node.ignored flag and ignoredDirs cache
    const isIgnored = node.ignored === true || state.ignoredDirs.has(node.path);
    const isModified = state.gitStatus.modified.has(node.path);
    const isUntracked = state.gitStatus.untracked.has(node.path);

    // Determine text color based on git status (modified takes precedence over untracked)
    const textColor = isModified
      ? "var(--color-git-modified)"
      : isUntracked
        ? "var(--color-git-untracked)"
        : undefined;

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
          onClick={() => {
            if (node.isDirectory) {
              toggleExpand(node);
            } else {
              props.onOpenFile?.(node.path);
            }
          }}
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
                <FolderOpen className="h-4 w-4 shrink-0 text-[var(--color-folder-icon)]" />
              ) : (
                <FolderClosed className="h-4 w-4 shrink-0 text-[var(--color-folder-icon)]" />
              )}
            </>
          ) : (
            <>
              <span className="w-3 shrink-0" />
              <FileIcon fileName={node.name} style={{ fontSize: 18 }} className="h-4 w-4" />
            </>
          )}
          <span className="truncate" style={textColor ? { color: textColor } : undefined}>
            {node.name}
          </span>
        </button>

        {node.isDirectory && isExpanded && (
          <div>{children.map((child) => renderNode(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  const rootEntries = state.entries.get("") ?? [];
  const isRootLoading = state.loading.has("");

  // Shorten workspace path for display (replace home dir with ~)
  const shortenPath = (fullPath: string): string => {
    // Match home directory patterns across platforms:
    // Linux: /home/username/...
    // macOS: /Users/username/...
    // Windows: C:\Users\username\... (may come as forward slashes too)
    const homePatterns = [
      /^\/home\/[^/]+/, // Linux
      /^\/Users\/[^/]+/, // macOS
      /^[A-Za-z]:[\\/]Users[\\/][^\\/]+/, // Windows
    ];

    for (const pattern of homePatterns) {
      const match = fullPath.match(pattern);
      if (match) {
        return "~" + fullPath.slice(match[0].length);
      }
    }
    return fullPath;
  };

  const displayPath = shortenPath(props.workspacePath);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="border-border-light flex items-center gap-1 border-b px-2 py-1">
        <FolderOpen className="h-4 w-4 shrink-0 text-[var(--color-folder-icon)]" />
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
          {hasExpandedDirs && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="text-muted hover:bg-accent/50 hover:text-foreground rounded p-1"
                  onClick={handleCollapseAll}
                  aria-label="Collapse All"
                >
                  <ChevronsDownUp className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Collapse All</TooltipContent>
            </Tooltip>
          )}
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
