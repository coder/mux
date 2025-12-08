/**
 * ReviewPanel - Main code review interface
 * Displays diff hunks for viewing changes in the workspace
 *
 * FILTERING ARCHITECTURE:
 *
 * Two-tier pipeline:
 *
 * 1. Git-level filters (affect data fetching):
 *    - diffBase: target branch/commit to diff against
 *    - includeUncommitted: include working directory changes
 *    - selectedFilePath: CRITICAL for truncation handling - when full diff
 *      exceeds bash output limits, path filter retrieves specific files
 *
 * 2. Frontend filters (applied in-memory to loaded hunks):
 *    - showReadHunks: hide hunks marked as reviewed
 *    - searchTerm: substring match on filenames + hunk content
 *
 * Why hybrid? Performance and necessity:
 * - selectedFilePath MUST be git-level (truncation recovery)
 * - search/read filters are better frontend (more flexible, simpler UX)
 * - Frontend filtering is fast even for 1000+ hunks (<5ms)
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { HunkViewer } from "./HunkViewer";
import { ReviewControls } from "./ReviewControls";
import { FileTree } from "./FileTree";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useReviewState } from "@/browser/hooks/useReviewState";
import { parseDiff, extractAllHunks, buildGitDiffCommand } from "@/common/utils/git/diffParser";
import { getReviewSearchStateKey } from "@/common/constants/storage";
import { Tooltip, TooltipWrapper } from "@/browser/components/Tooltip";
import { parseNumstat, buildFileTree, extractNewPath } from "@/common/utils/git/numstatParser";
import type { DiffHunk, ReviewFilters as ReviewFiltersType } from "@/common/types/review";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import { matchesKeybind, KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { applyFrontendFilters } from "@/browser/utils/review/filterHunks";
import { cn } from "@/common/lib/utils";
import { useAPI } from "@/browser/contexts/API";

interface ReviewPanelProps {
  workspaceId: string;
  workspacePath: string;
  onReviewNote?: (note: string) => void;
  /** Trigger to focus panel (increment to trigger) */
  focusTrigger?: number;
  /** Workspace is still being created (git operations in progress) */
  isCreating?: boolean;
}

interface ReviewSearchState {
  input: string;
  useRegex: boolean;
  matchCase: boolean;
}

interface DiagnosticInfo {
  command: string;
  outputLength: number;
  fileDiffCount: number;
  hunkCount: number;
}

/**
 * Discriminated union for diff loading state.
 * Makes it impossible to show "No changes" while loading.
 *
 * Note: Parent uses key={workspaceId} so component remounts on workspace change,
 * guaranteeing fresh state. No need to track workspaceId in state.
 */
type DiffState =
  | { status: "loading" }
  | { status: "refreshing"; hunks: DiffHunk[]; truncationWarning: string | null }
  | { status: "loaded"; hunks: DiffHunk[]; truncationWarning: string | null }
  | { status: "error"; message: string };

export const ReviewPanel: React.FC<ReviewPanelProps> = ({
  workspaceId,
  workspacePath,
  onReviewNote,
  focusTrigger,
  isCreating = false,
}) => {
  const { api } = useAPI();
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Unified diff state - discriminated union makes invalid states unrepresentable
  // Note: Parent renders with key={workspaceId}, so component remounts on workspace change
  const [diffState, setDiffState] = useState<DiffState>({ status: "loading" });

  const [selectedHunkId, setSelectedHunkId] = useState<string | null>(null);
  const [isLoadingTree, setIsLoadingTree] = useState(true);
  const [diagnosticInfo, setDiagnosticInfo] = useState<DiagnosticInfo | null>(null);
  const [isPanelFocused, setIsPanelFocused] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [fileTree, setFileTree] = useState<FileTreeNode | null>(null);
  // Map of hunkId -> toggle function for expand/collapse
  const toggleExpandFnsRef = useRef<Map<string, () => void>>(new Map());

  // Unified search state (per-workspace persistence)
  const [searchState, setSearchState] = usePersistedState<ReviewSearchState>(
    getReviewSearchStateKey(workspaceId),
    { input: "", useRegex: false, matchCase: false }
  );
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");

  // Persist file filter per workspace
  const [selectedFilePath, setSelectedFilePath] = usePersistedState<string | null>(
    `review-file-filter:${workspaceId}`,
    null
  );

  // Global default base (shared across all workspaces)
  const [defaultBase] = usePersistedState<string>("review-default-base", "HEAD");

  // Persist diff base per workspace (falls back to global default)
  const [diffBase, setDiffBase] = usePersistedState(`review-diff-base:${workspaceId}`, defaultBase);

  // Persist includeUncommitted flag globally
  const [includeUncommitted, setIncludeUncommitted] = usePersistedState(
    "review-include-uncommitted",
    false
  );

  // Persist showReadHunks flag globally
  const [showReadHunks, setShowReadHunks] = usePersistedState("review-show-read", true);

  // Initialize review state hook
  const { isRead, toggleRead, markAsRead, markAsUnread } = useReviewState(workspaceId);

  // Derive hunks from diffState for use in filters and rendering
  const hunks = useMemo(
    () =>
      diffState.status === "loaded" || diffState.status === "refreshing" ? diffState.hunks : [],
    [diffState]
  );

  const [filters, setFilters] = useState<ReviewFiltersType>({
    showReadHunks: showReadHunks,
    diffBase: diffBase,
    includeUncommitted: includeUncommitted,
  });

  // Focus panel when focusTrigger changes (preserves current hunk selection)
  useEffect(() => {
    if (focusTrigger && focusTrigger > 0) {
      panelRef.current?.focus();
    }
  }, [focusTrigger]);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchState.input);
    }, 150);
    return () => clearTimeout(timer);
  }, [searchState.input]);

  // Load file tree - when workspace, diffBase, or refreshTrigger changes
  useEffect(() => {
    // Skip data loading while workspace is being created
    if (!api || isCreating) return;
    let cancelled = false;

    const loadFileTree = async () => {
      setIsLoadingTree(true);
      try {
        const numstatCommand = buildGitDiffCommand(
          filters.diffBase,
          filters.includeUncommitted,
          "", // No path filter for file tree
          "numstat"
        );

        const numstatResult = await api.workspace.executeBash({
          workspaceId,
          script: numstatCommand,
          options: { timeout_secs: 30 },
        });

        if (cancelled) return;

        if (numstatResult.success) {
          const numstatOutput = numstatResult.data.output ?? "";
          const fileStats = parseNumstat(numstatOutput);

          // Build tree with original paths (needed for git commands)
          const tree = buildFileTree(fileStats);
          setFileTree(tree);
        }
      } catch (err) {
        console.error("Failed to load file tree:", err);
      } finally {
        setIsLoadingTree(false);
      }
    };

    void loadFileTree();

    return () => {
      cancelled = true;
    };
  }, [
    api,
    workspaceId,
    workspacePath,
    filters.diffBase,
    filters.includeUncommitted,
    refreshTrigger,
    isCreating,
  ]);

  // Load diff hunks - when workspace, diffBase, selected path, or refreshTrigger changes
  useEffect(() => {
    // Skip data loading while workspace is being created
    if (!api || isCreating) return;
    let cancelled = false;

    // Transition to appropriate loading state:
    // - "refreshing" if we have data (keeps UI stable during refresh)
    // - "loading" if no data yet
    setDiffState((prev) => {
      if (prev.status === "loaded" || prev.status === "refreshing") {
        return {
          status: "refreshing",
          hunks: prev.hunks,
          truncationWarning: prev.truncationWarning,
        };
      }
      return { status: "loading" };
    });

    const loadDiff = async () => {
      try {
        // Git-level filters (affect what data is fetched):
        // - diffBase: what to diff against
        // - includeUncommitted: include working directory changes
        // - selectedFilePath: ESSENTIAL for truncation - if full diff is cut off,
        //   path filter lets us retrieve specific file's hunks
        const pathFilter = selectedFilePath ? ` -- "${extractNewPath(selectedFilePath)}"` : "";

        const diffCommand = buildGitDiffCommand(
          filters.diffBase,
          filters.includeUncommitted,
          pathFilter,
          "diff"
        );

        // Fetch diff
        const diffResult = await api.workspace.executeBash({
          workspaceId,
          script: diffCommand,
          options: { timeout_secs: 30 },
        });

        if (cancelled) return;

        if (!diffResult.success) {
          // Real error (not truncation-related)
          console.error("Git diff failed:", diffResult.error);
          setDiffState({ status: "error", message: diffResult.error ?? "Unknown error" });
          setDiagnosticInfo(null);
          return;
        }

        const diffOutput = diffResult.data.output ?? "";
        const truncationInfo = diffResult.data.truncated;

        const fileDiffs = parseDiff(diffOutput);
        const allHunks = extractAllHunks(fileDiffs);

        // Store diagnostic info
        setDiagnosticInfo({
          command: diffCommand,
          outputLength: diffOutput.length,
          fileDiffCount: fileDiffs.length,
          hunkCount: allHunks.length,
        });

        // Build truncation warning (only when not filtering by path)
        const truncationWarning =
          truncationInfo && !selectedFilePath
            ? `Diff truncated (${truncationInfo.reason}). Filter by file to see more.`
            : null;

        // Single atomic state update with all data
        setDiffState({ status: "loaded", hunks: allHunks, truncationWarning });

        // Auto-select first hunk if none selected
        if (allHunks.length > 0 && !selectedHunkId) {
          setSelectedHunkId(allHunks[0].id);
        }
      } catch (err) {
        if (cancelled) return;
        const errorMsg = `Failed to load diff: ${err instanceof Error ? err.message : String(err)}`;
        console.error(errorMsg);
        setDiffState({ status: "error", message: errorMsg });
      }
    };

    void loadDiff();

    return () => {
      cancelled = true;
    };
    // selectedHunkId intentionally omitted - only auto-select on initial load, not on every selection change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspaceId,
    workspacePath,
    filters.diffBase,
    filters.includeUncommitted,
    selectedFilePath,
    refreshTrigger,
    isCreating,
  ]);

  // Persist diffBase when it changes
  useEffect(() => {
    setDiffBase(filters.diffBase);
  }, [filters.diffBase, setDiffBase]);

  // Persist includeUncommitted when it changes
  useEffect(() => {
    setIncludeUncommitted(filters.includeUncommitted);
  }, [filters.includeUncommitted, setIncludeUncommitted]);

  // Persist showReadHunks when it changes
  useEffect(() => {
    setShowReadHunks(filters.showReadHunks);
  }, [filters.showReadHunks, setShowReadHunks]);

  // Get read status for a file
  const getFileReadStatus = useCallback(
    (filePath: string) => {
      const fileHunks = hunks.filter((h) => h.filePath === filePath);
      if (fileHunks.length === 0) {
        return null; // Unknown state - no hunks loaded for this file
      }
      const total = fileHunks.length;
      const read = fileHunks.filter((h) => isRead(h.id)).length;
      return { total, read };
    },
    [hunks, isRead]
  );

  // Apply frontend filters (read state, search term)
  // Note: selectedFilePath is a git-level filter, applied when fetching hunks
  const filteredHunks = useMemo(() => {
    return applyFrontendFilters(hunks, {
      showReadHunks: filters.showReadHunks,
      isRead,
      searchTerm: debouncedSearchTerm,
      useRegex: searchState.useRegex,
      matchCase: searchState.matchCase,
    });
  }, [
    hunks,
    filters.showReadHunks,
    isRead,
    debouncedSearchTerm,
    searchState.useRegex,
    searchState.matchCase,
  ]);

  // Memoize search config to prevent re-creating object on every render
  // This allows React.memo on HunkViewer to work properly
  const searchConfig = useMemo(
    () =>
      debouncedSearchTerm
        ? {
            searchTerm: debouncedSearchTerm,
            useRegex: searchState.useRegex,
            matchCase: searchState.matchCase,
          }
        : undefined,
    [debouncedSearchTerm, searchState.useRegex, searchState.matchCase]
  );

  // Handle toggling read state with auto-navigation
  const handleToggleRead = useCallback(
    (hunkId: string) => {
      const wasRead = isRead(hunkId);
      toggleRead(hunkId);

      // If toggling the selected hunk, check if it will still be visible after toggle
      if (hunkId === selectedHunkId) {
        // Hunk is visible if: showReadHunks is on OR it will be unread after toggle
        const willBeVisible = filters.showReadHunks || wasRead;

        if (!willBeVisible) {
          // Compute filtered hunks here to avoid dependency on filteredHunks array
          const currentFiltered = filters.showReadHunks
            ? hunks
            : hunks.filter((h) => !isRead(h.id));

          // Hunk will be filtered out - move to next visible hunk
          const currentIndex = currentFiltered.findIndex((h) => h.id === hunkId);
          if (currentIndex !== -1) {
            if (currentIndex < currentFiltered.length - 1) {
              setSelectedHunkId(currentFiltered[currentIndex + 1].id);
            } else if (currentIndex > 0) {
              setSelectedHunkId(currentFiltered[currentIndex - 1].id);
            } else {
              setSelectedHunkId(null);
            }
          }
        }
      }
    },
    [isRead, toggleRead, filters.showReadHunks, hunks, selectedHunkId]
  );

  // Handle marking hunk as read with auto-navigation
  const handleMarkAsRead = useCallback(
    (hunkId: string) => {
      const wasRead = isRead(hunkId);
      markAsRead(hunkId);

      // If marking the selected hunk as read and it will be filtered out, navigate
      if (hunkId === selectedHunkId && !wasRead && !filters.showReadHunks) {
        // Hunk will be filtered out - move to next visible hunk
        const currentFiltered = hunks.filter((h) => !isRead(h.id));
        const currentIndex = currentFiltered.findIndex((h) => h.id === hunkId);
        if (currentIndex !== -1) {
          if (currentIndex < currentFiltered.length - 1) {
            setSelectedHunkId(currentFiltered[currentIndex + 1].id);
          } else if (currentIndex > 0) {
            setSelectedHunkId(currentFiltered[currentIndex - 1].id);
          } else {
            setSelectedHunkId(null);
          }
        }
      }
    },
    [isRead, markAsRead, filters.showReadHunks, hunks, selectedHunkId]
  );

  // Handle marking hunk as unread (no navigation needed - unread hunks are always visible)
  const handleMarkAsUnread = useCallback(
    (hunkId: string) => {
      markAsUnread(hunkId);
    },
    [markAsUnread]
  );

  // Stable callbacks for HunkViewer (single callback shared across all hunks)
  const handleHunkClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const hunkId = e.currentTarget.dataset.hunkId;
    if (hunkId) setSelectedHunkId(hunkId);
  }, []);

  const handleHunkToggleRead = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const hunkId = e.currentTarget.dataset.hunkId;
      if (hunkId) handleToggleRead(hunkId);
    },
    [handleToggleRead]
  );

  const handleRegisterToggleExpand = useCallback((hunkId: string, toggleFn: () => void) => {
    toggleExpandFnsRef.current.set(hunkId, toggleFn);
  }, []);

  // Handle marking all hunks in a file as read
  const handleMarkFileAsRead = useCallback(
    (hunkId: string) => {
      // Find the hunk to determine its file path
      const hunk = hunks.find((h) => h.id === hunkId);
      if (!hunk) return;

      // Find all hunks in the same file
      const fileHunkIds = hunks.filter((h) => h.filePath === hunk.filePath).map((h) => h.id);

      // Mark all hunks in the file as read
      markAsRead(fileHunkIds);

      // If marking the selected hunk's file as read and hunks will be filtered out, navigate
      if (hunkId === selectedHunkId && !filters.showReadHunks) {
        // Find the next visible hunk that's not in the same file
        const currentFiltered = hunks.filter((h) => !isRead(h.id) && h.filePath !== hunk.filePath);
        if (currentFiltered.length > 0) {
          setSelectedHunkId(currentFiltered[0].id);
        } else {
          setSelectedHunkId(null);
        }
      }
    },
    [hunks, markAsRead, isRead, filters.showReadHunks, selectedHunkId]
  );

  // Calculate stats
  const stats = useMemo(() => {
    const total = hunks.length;
    const read = hunks.filter((h) => isRead(h.id)).length;
    return {
      total,
      read,
      unread: total - read,
    };
  }, [hunks, isRead]);

  // Scroll selected hunk into view
  useEffect(() => {
    if (!selectedHunkId) return;

    // Find the hunk container element by data attribute
    const hunkElement = document.querySelector(`[data-hunk-id="${selectedHunkId}"]`);
    if (hunkElement) {
      hunkElement.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [selectedHunkId]);

  // Keyboard navigation (j/k or arrow keys) - only when panel is focused
  useEffect(() => {
    if (!isPanelFocused) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't interfere with text input in chat or other editable elements
      if (e.target instanceof HTMLElement) {
        const tagName = e.target.tagName.toLowerCase();
        if (tagName === "input" || tagName === "textarea" || e.target.contentEditable === "true") {
          return;
        }
      }

      if (!selectedHunkId) return;

      const currentIndex = filteredHunks.findIndex((h) => h.id === selectedHunkId);
      if (currentIndex === -1) return;

      // Navigation
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        if (currentIndex < filteredHunks.length - 1) {
          setSelectedHunkId(filteredHunks[currentIndex + 1].id);
        }
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (currentIndex > 0) {
          setSelectedHunkId(filteredHunks[currentIndex - 1].id);
        }
      } else if (matchesKeybind(e, KEYBINDS.TOGGLE_HUNK_READ)) {
        // Toggle read state of selected hunk
        e.preventDefault();
        handleToggleRead(selectedHunkId);
      } else if (matchesKeybind(e, KEYBINDS.MARK_HUNK_READ)) {
        // Mark selected hunk as read
        e.preventDefault();
        handleMarkAsRead(selectedHunkId);
      } else if (matchesKeybind(e, KEYBINDS.MARK_HUNK_UNREAD)) {
        // Mark selected hunk as unread
        e.preventDefault();
        handleMarkAsUnread(selectedHunkId);
      } else if (matchesKeybind(e, KEYBINDS.MARK_FILE_READ)) {
        // Mark entire file (all hunks) as read
        e.preventDefault();
        handleMarkFileAsRead(selectedHunkId);
      } else if (matchesKeybind(e, KEYBINDS.TOGGLE_HUNK_COLLAPSE)) {
        // Toggle expand/collapse state of selected hunk
        e.preventDefault();
        const toggleFn = toggleExpandFnsRef.current.get(selectedHunkId);
        if (toggleFn) {
          toggleFn();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isPanelFocused,
    selectedHunkId,
    filteredHunks,
    handleToggleRead,
    handleMarkAsRead,
    handleMarkAsUnread,
    handleMarkFileAsRead,
  ]);

  // Global keyboard shortcuts (Ctrl+R / Cmd+R for refresh, Ctrl+F / Cmd+F for search)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.REFRESH_REVIEW)) {
        e.preventDefault();
        setRefreshTrigger((prev) => prev + 1);
      } else if (matchesKeybind(e, KEYBINDS.FOCUS_REVIEW_SEARCH)) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Show loading state while workspace is being created
  if (isCreating) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center">
        <div className="mb-4 text-2xl">⏳</div>
        <p className="text-secondary text-sm">Setting up workspace...</p>
        <p className="text-secondary mt-1 text-xs">Review will be available once ready</p>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      tabIndex={0}
      onFocus={() => setIsPanelFocused(true)}
      onBlur={() => setIsPanelFocused(false)}
      className="bg-dark [container-type:inline-size] flex h-full min-h-0 flex-col outline-none [container-name:review-panel] focus-within:shadow-[inset_0_0_0_1px_rgba(0,122,204,0.2)]"
    >
      {/* Always show controls so user can change diff base */}
      <ReviewControls
        filters={filters}
        stats={stats}
        onFiltersChange={setFilters}
        onRefresh={() => setRefreshTrigger((prev) => prev + 1)}
        isLoading={
          diffState.status === "loading" || diffState.status === "refreshing" || isLoadingTree
        }
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        refreshTrigger={refreshTrigger}
      />

      {diffState.status === "error" ? (
        <div className="text-danger-soft bg-danger-soft/10 border-danger-soft/30 font-monospace m-3 rounded border p-6 text-xs leading-[1.5] break-words whitespace-pre-wrap">
          {diffState.message}
        </div>
      ) : diffState.status === "loading" ? (
        <div className="text-muted flex h-full items-center justify-center text-sm">
          Loading diff...
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {diffState.truncationWarning && (
            <div className="bg-warning/10 border-warning/30 text-warning mx-3 my-3 flex items-center gap-1.5 rounded border px-3 py-1.5 text-[10px] leading-[1.3] before:text-xs before:content-['⚠️']">
              {diffState.truncationWarning}
            </div>
          )}

          {/* Search bar - always visible at top, not sticky */}
          <div className="border-border-light bg-separator border-b px-3 py-2">
            <div className="border-border-light bg-dark hover:border-border-gray focus-within:border-accent focus-within:hover:border-accent flex items-stretch overflow-hidden rounded border transition-[border-color] duration-150">
              <input
                ref={searchInputRef}
                type="text"
                placeholder={`Search in files and hunks... (${formatKeybind(KEYBINDS.FOCUS_REVIEW_SEARCH)})`}
                value={searchState.input}
                onChange={(e) => setSearchState({ ...searchState, input: e.target.value })}
                className="text-foreground placeholder:text-dim focus:bg-separator flex h-full flex-1 items-center border-none bg-transparent px-2.5 py-1.5 font-sans text-xs leading-[1.4] outline-none"
              />
              <TooltipWrapper inline>
                <button
                  className={cn(
                    "py-1.5 px-2.5 border-none border-l border-light text-[11px] font-monospace font-semibold leading-[1.4] cursor-pointer outline-none transition-all duration-150 whitespace-nowrap flex items-center h-full",
                    searchState.useRegex
                      ? "bg-review-bg-blue text-accent-light shadow-[inset_0_0_0_1px_rgba(77,184,255,0.4)] hover:bg-review-bg-info hover:text-accent-light"
                      : "bg-transparent text-subtle hover:bg-separator hover:text-foreground",
                    "active:translate-y-px"
                  )}
                  onClick={() =>
                    setSearchState({ ...searchState, useRegex: !searchState.useRegex })
                  }
                >
                  .*
                </button>
                <Tooltip position="bottom">
                  {searchState.useRegex ? "Using regex search" : "Using substring search"}
                </Tooltip>
              </TooltipWrapper>
              <TooltipWrapper inline>
                <button
                  className={cn(
                    "py-1.5 px-2.5 border-none border-l border-light text-[11px] font-monospace font-semibold leading-[1.4] cursor-pointer outline-none transition-all duration-150 whitespace-nowrap flex items-center h-full",
                    searchState.matchCase
                      ? "bg-review-bg-blue text-accent-light shadow-[inset_0_0_0_1px_rgba(77,184,255,0.4)] hover:bg-review-bg-info hover:text-accent-light"
                      : "bg-transparent text-subtle hover:bg-separator hover:text-foreground",
                    "active:translate-y-px"
                  )}
                  onClick={() =>
                    setSearchState({ ...searchState, matchCase: !searchState.matchCase })
                  }
                >
                  Aa
                </button>
                <Tooltip position="bottom">
                  {searchState.matchCase
                    ? "Match case (case-sensitive)"
                    : "Ignore case (case-insensitive)"}
                </Tooltip>
              </TooltipWrapper>
            </div>
          </div>

          {/* Single scrollable area containing both file tree and hunks */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {/* FileTree at the top */}
            {(fileTree ?? isLoadingTree) && (
              <div className="border-border-light flex w-full flex-[0_0_auto] flex-col overflow-hidden border-b">
                <FileTree
                  root={fileTree}
                  selectedPath={selectedFilePath}
                  onSelectFile={setSelectedFilePath}
                  isLoading={isLoadingTree}
                  getFileReadStatus={getFileReadStatus}
                  workspaceId={workspaceId}
                />
              </div>
            )}

            {/* Hunks below the file tree */}
            <div className="flex flex-[0_0_auto] flex-col p-3">
              {hunks.length === 0 ? (
                <div className="text-muted flex flex-col items-center justify-start gap-3 px-6 pt-12 pb-6 text-center">
                  <div className="text-foreground text-base font-medium">No changes found</div>
                  <div className="text-[13px] leading-[1.5]">
                    No changes found for the selected diff base.
                    <br />
                    Try selecting a different base or make some changes.
                  </div>
                  {diagnosticInfo && (
                    <details className="bg-modal-bg border-border-light [&_summary]:text-muted mt-4 w-full max-w-96 cursor-pointer rounded border p-3 [&_summary]:flex [&_summary]:list-none [&_summary]:items-center [&_summary]:gap-1.5 [&_summary]:text-xs [&_summary]:font-medium [&_summary]:select-none [&_summary::-webkit-details-marker]:hidden [&_summary::before]:text-[10px] [&_summary::before]:transition-transform [&_summary::before]:duration-200 [&_summary::before]:content-['▶'] [&[open]_summary::before]:rotate-90">
                      <summary>Show diagnostic info</summary>
                      <div className="font-monospace text-foreground mt-3 text-[11px] leading-[1.6]">
                        <div className="[&:not(:last-child)]:border-border-light grid grid-cols-[140px_1fr] gap-3 py-1 [&:not(:last-child)]:border-b">
                          <div className="text-muted font-medium">Command:</div>
                          <div className="text-foreground break-all select-all">
                            {diagnosticInfo.command}
                          </div>
                        </div>
                        <div className="[&:not(:last-child)]:border-border-light grid grid-cols-[140px_1fr] gap-3 py-1 [&:not(:last-child)]:border-b">
                          <div className="text-muted font-medium">Output size:</div>
                          <div className="text-foreground break-all select-all">
                            {diagnosticInfo.outputLength.toLocaleString()} bytes
                          </div>
                        </div>
                        <div className="[&:not(:last-child)]:border-border-light grid grid-cols-[140px_1fr] gap-3 py-1 [&:not(:last-child)]:border-b">
                          <div className="text-muted font-medium">Files parsed:</div>
                          <div className="text-foreground break-all select-all">
                            {diagnosticInfo.fileDiffCount}
                          </div>
                        </div>
                        <div className="grid grid-cols-[140px_1fr] gap-3 py-1">
                          <div className="text-muted font-medium">Hunks extracted:</div>
                          <div className="text-foreground break-all select-all">
                            {diagnosticInfo.hunkCount}
                          </div>
                        </div>
                      </div>
                    </details>
                  )}
                </div>
              ) : filteredHunks.length === 0 ? (
                <div className="text-muted flex flex-col items-center justify-start gap-3 px-6 pt-12 pb-6 text-center">
                  <div className="text-[13px] leading-[1.5]">
                    {debouncedSearchTerm.trim()
                      ? `No hunks match "${debouncedSearchTerm}". Try a different search term.`
                      : selectedFilePath
                        ? `No hunks in ${selectedFilePath}. Try selecting a different file.`
                        : "No hunks match the current filters. Try adjusting your filter settings."}
                  </div>
                </div>
              ) : (
                filteredHunks.map((hunk) => {
                  const isSelected = hunk.id === selectedHunkId;
                  const hunkIsRead = isRead(hunk.id);

                  return (
                    <HunkViewer
                      key={hunk.id}
                      hunk={hunk}
                      hunkId={hunk.id}
                      workspaceId={workspaceId}
                      isSelected={isSelected}
                      isRead={hunkIsRead}
                      onClick={handleHunkClick}
                      onToggleRead={handleHunkToggleRead}
                      onRegisterToggleExpand={handleRegisterToggleExpand}
                      onReviewNote={onReviewNote}
                      searchConfig={searchConfig}
                    />
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
