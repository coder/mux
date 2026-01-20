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

import { LRUCache } from "lru-cache";
import { AlertTriangle, Lightbulb, Loader2 } from "lucide-react";
import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { HunkViewer } from "./HunkViewer";
import type { ReviewActionCallbacks } from "../../shared/InlineReviewNote";
import { ReviewControls } from "./ReviewControls";
import { FileTree } from "./FileTree";
import { UntrackedStatus } from "./UntrackedStatus";
import { shellQuote } from "@/common/utils/shell";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { STORAGE_KEYS, WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { useReviewState } from "@/browser/hooks/useReviewState";
import { useReviews } from "@/browser/hooks/useReviews";
import { useHunkFirstSeen } from "@/browser/hooks/useHunkFirstSeen";
import { RefreshController, type LastRefreshInfo } from "@/browser/utils/RefreshController";
import { parseDiff, extractAllHunks, buildGitDiffCommand } from "@/common/utils/git/diffParser";
import { getReviewSearchStateKey, REVIEW_SORT_ORDER_KEY } from "@/common/constants/storage";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/ui/tooltip";
import { parseNumstat, buildFileTree, extractNewPath } from "@/common/utils/git/numstatParser";
import { parseNameStatus } from "@/common/utils/git/nameStatusParser";
import type {
  DiffHunk,
  ReviewFilters as ReviewFiltersType,
  ReviewNoteData,
  ReviewSortOrder,
} from "@/common/types/review";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import { matchesKeybind, KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { applyFrontendFilters } from "@/browser/utils/review/filterHunks";
import { findNextHunkId, findNextHunkIdAfterFileRemoval } from "@/browser/utils/review/navigation";
import { cn } from "@/common/lib/utils";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { invalidateGitStatus } from "@/browser/stores/GitStatusStore";

/** Stats reported to parent for tab display */
interface ReviewPanelStats {
  total: number;
  read: number;
}

interface ReviewPanelProps {
  workspaceId: string;
  workspacePath: string;
  projectPath: string;
  onReviewNote?: (data: ReviewNoteData) => void;
  /** Trigger to focus panel (increment to trigger) */
  focusTrigger?: number;
  /** Workspace is still being created (git operations in progress) */
  isCreating?: boolean;
  /** Callback to report stats changes (for tab badge) */
  onStatsChange?: (stats: ReviewPanelStats) => void;
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

const REVIEW_PANEL_CACHE_MAX_ENTRIES = 20;
const REVIEW_PANEL_CACHE_MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

/**
 * Preserve object references for unchanged hunks to prevent re-renders.
 * Compares by ID and content - if a hunk exists in prev with same content, reuse it.
 */
function preserveHunkReferences(prev: DiffHunk[], next: DiffHunk[]): DiffHunk[] {
  if (prev.length === 0) return next;

  const prevById = new Map(prev.map((h) => [h.id, h]));
  let allSame = prev.length === next.length;

  const result = next.map((hunk, i) => {
    const prevHunk = prevById.get(hunk.id);
    // Fast path: same ID and content means unchanged (content hash is part of ID)
    if (prevHunk?.content === hunk.content) {
      if (allSame && prev[i]?.id !== hunk.id) allSame = false;
      return prevHunk;
    }
    allSame = false;
    return hunk;
  });

  // If all hunks are reused in same order, return prev array to preserve top-level reference
  return allSame ? prev : result;
}

interface ReviewPanelDiffCacheValue {
  hunks: DiffHunk[];
  truncationWarning: string | null;
  diagnosticInfo: DiagnosticInfo | null;
}

type ReviewPanelCacheValue = ReviewPanelDiffCacheValue | FileTreeNode;

function estimateJsonSizeBytes(value: unknown): number {
  // Rough bytes for JS strings (UTF-16). Used only for LRU sizing.
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    // If we ever hit an unserializable structure, treat it as huge so it won't stick in cache.
    return Number.MAX_SAFE_INTEGER;
  }
}

const reviewPanelCache = new LRUCache<string, ReviewPanelCacheValue>({
  max: REVIEW_PANEL_CACHE_MAX_ENTRIES,
  maxSize: REVIEW_PANEL_CACHE_MAX_SIZE_BYTES,
  sizeCalculation: (value) => estimateJsonSizeBytes(value),
});

function getOriginBranchForFetch(diffBase: string): string | null {
  const trimmed = diffBase.trim();
  if (!trimmed.startsWith("origin/")) return null;

  const branch = trimmed.slice("origin/".length);
  if (branch.length === 0) return null;

  return branch;
}

interface OriginFetchState {
  key: string;
  promise: Promise<void>;
}

async function ensureOriginFetched(params: {
  api: APIClient;
  workspaceId: string;
  diffBase: string;
  refreshToken: number;
  originFetchRef: React.MutableRefObject<OriginFetchState | null>;
}): Promise<void> {
  const originBranch = getOriginBranchForFetch(params.diffBase);
  if (!originBranch) return;

  const key = [params.workspaceId, params.diffBase, String(params.refreshToken)].join("\u0000");
  const existing = params.originFetchRef.current;
  if (existing?.key === key) {
    await existing.promise;
    return;
  }

  // Ensure manual refresh doesn't hang on credential prompts.
  const promise = params.api.workspace
    .executeBash({
      workspaceId: params.workspaceId,
      script: `GIT_TERMINAL_PROMPT=0 git fetch origin ${shellQuote(originBranch)} --quiet || true`,
      options: { timeout_secs: 30 },
    })
    .then(() => undefined)
    .catch(() => undefined);

  params.originFetchRef.current = { key, promise };
  await promise;
}
function makeReviewPanelCacheKey(params: {
  workspaceId: string;
  workspacePath: string;
  gitCommand: string;
}): string {
  // Key off the actual git command to avoid forgetting to include new inputs.
  return [params.workspaceId, params.workspacePath, params.gitCommand].join("\u0000");
}

type ExecuteBashResult = Awaited<ReturnType<APIClient["workspace"]["executeBash"]>>;
type ExecuteBashSuccess = Extract<ExecuteBashResult, { success: true }>;

async function executeWorkspaceBashAndCache<T extends ReviewPanelCacheValue>(params: {
  api: APIClient;
  workspaceId: string;
  script: string;
  cacheKey: string;
  timeoutSecs: number;
  parse: (result: ExecuteBashSuccess) => T;
}): Promise<T> {
  const result = await params.api.workspace.executeBash({
    workspaceId: params.workspaceId,
    script: params.script,
    options: { timeout_secs: params.timeoutSecs },
  });

  if (!result.success) {
    throw new Error(result.error ?? "Unknown error");
  }

  const value = params.parse(result);
  reviewPanelCache.set(params.cacheKey, value);
  return value;
}

export const ReviewPanel: React.FC<ReviewPanelProps> = ({
  workspaceId,
  workspacePath,
  projectPath,
  onReviewNote,
  focusTrigger,
  isCreating = false,
  onStatsChange,
}) => {
  const originFetchRef = useRef<OriginFetchState | null>(null);
  const { api } = useAPI();
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Unified diff state - discriminated union makes invalid states unrepresentable
  // Note: Parent renders with key={workspaceId}, so component remounts on workspace change.
  const [diffState, setDiffState] = useState<DiffState>({ status: "loading" });

  // Persist selected hunk per workspace so navigation survives tab switches
  const [selectedHunkId, setSelectedHunkId] = usePersistedState<string | null>(
    `review-selected-hunk:${workspaceId}`,
    null
  );
  const [isLoadingTree, setIsLoadingTree] = useState(true);
  const [diagnosticInfo, setDiagnosticInfo] = useState<DiagnosticInfo | null>(null);
  const [isPanelFocused, setIsPanelFocused] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [fileTree, setFileTree] = useState<FileTreeNode | null>(null);

  // Map of hunkId -> toggle function for expand/collapse
  const toggleExpandFnsRef = useRef<Map<string, () => void>>(new Map());

  // Ref to hold current filteredHunks for use in navigation callbacks.
  // Avoids needing filteredHunks as a dependency (which changes frequently).
  const filteredHunksRef = useRef<DiffHunk[]>([]);

  // Track refresh trigger changes so we can distinguish initial mount vs manual refresh.
  // Each effect gets its own ref to avoid cross-effect interference.
  const lastDiffRefreshTriggerRef = useRef<number | null>(null);
  const lastFileTreeRefreshTriggerRef = useRef<number | null>(null);

  // Check if tools completed while we were unmounted - skip cache on initial mount if so.
  // Computed once on mount, consumed after first load to avoid re-fetching on every mount.
  const skipCacheOnMountRef = useRef(
    workspaceStore.getFileModifyingToolMs(workspaceId) !== undefined
  );

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

  // Per-project default base (shared across workspaces in the same project)
  // Default is HEAD for compatibility; users can change per-project via UI
  const [defaultBase] = usePersistedState<string>(
    STORAGE_KEYS.reviewDefaultBase(projectPath),
    WORKSPACE_DEFAULTS.reviewBase,
    { listener: true }
  );

  // Persist diff base per workspace (falls back to project default)
  // Uses listener: true to sync with GitStatusIndicator base selector
  const [diffBase, setDiffBase] = usePersistedState(
    STORAGE_KEYS.reviewDiffBase(workspaceId),
    defaultBase,
    { listener: true }
  );

  // Persist includeUncommitted flag globally
  const [includeUncommitted, setIncludeUncommitted] = usePersistedState(
    "review-include-uncommitted",
    false
  );

  // Persist showReadHunks flag globally
  const [showReadHunks, setShowReadHunks] = usePersistedState("review-show-read", true);

  // Persist sort order globally
  const [sortOrder, setSortOrder] = usePersistedState<ReviewSortOrder>(
    REVIEW_SORT_ORDER_KEY,
    "last-edit"
  );

  // Initialize review state hook
  const { isRead, toggleRead, markAsRead, markAsUnread } = useReviewState(workspaceId);

  // Refs for values that change frequently but are only read at callback invocation time.
  // Using refs allows callbacks to stay stable (same reference) while still accessing current values.
  // This prevents all HunkViewer components from re-rendering when these values change.
  const isReadRef = useRef(isRead);
  isReadRef.current = isRead;
  const selectedHunkIdRef = useRef(selectedHunkId);
  selectedHunkIdRef.current = selectedHunkId;
  const showReadHunksRef = useRef(false); // Will be updated after filters state is declared

  // Track hunk first-seen timestamps for LIFO sorting
  const { recordFirstSeen, firstSeenMap } = useHunkFirstSeen(workspaceId);

  const {
    reviews,
    updateReviewNote,
    checkReview,
    uncheckReview,
    attachReview,
    detachReview,
    removeReview,
  } = useReviews(workspaceId);

  const reviewsByFilePath = useMemo(() => {
    const grouped = new Map<string, typeof reviews>();

    for (const review of reviews) {
      const filePath = review.data?.filePath;
      if (!filePath) continue;

      const existing = grouped.get(filePath);
      if (existing) {
        existing.push(review);
      } else {
        grouped.set(filePath, [review]);
      }
    }

    return grouped;
  }, [reviews]);

  // Memoized review action callbacks for inline review notes
  const reviewActions: ReviewActionCallbacks = useMemo(
    () => ({
      onEditComment: updateReviewNote,
      onComplete: checkReview,
      onUncheck: uncheckReview,
      onAttach: attachReview,
      onDetach: detachReview,
      onDelete: removeReview,
    }),
    [updateReviewNote, checkReview, uncheckReview, attachReview, detachReview, removeReview]
  );

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
    sortOrder: sortOrder,
  });

  // Keep filters in sync with persisted state when updates come from outside this panel
  // (e.g., GitStatusIndicator base selector).
  useEffect(() => {
    setFilters((prev) => {
      if (prev.diffBase === diffBase) {
        return prev;
      }

      return { ...prev, diffBase };
    });
  }, [diffBase]);

  // Git status uses diffBase too; refresh immediately when it changes.
  const lastGitStatusBaseRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastGitStatusBaseRef.current !== null && lastGitStatusBaseRef.current !== diffBase) {
      invalidateGitStatus(workspaceId);
    }

    lastGitStatusBaseRef.current = diffBase;
  }, [workspaceId, diffBase]);

  // Keep showReadHunksRef in sync for stable callbacks
  showReadHunksRef.current = filters.showReadHunks;

  // Ref to track when user is interacting (pauses auto-refresh)
  const isInteractingRef = useRef(false);

  // Track if user is composing a review note (pauses auto-refresh to prevent losing work)
  // Uses a Set to track which hunks have active selections (multiple hunks possible)
  const isComposingReviewNoteRef = useRef(false);
  const composingHunksRef = useRef(new Set<string>());

  // Handler for when a hunk's composing state changes
  const handleHunkComposingChange = useCallback((hunkId: string, isComposing: boolean) => {
    if (isComposing) {
      composingHunksRef.current.add(hunkId);
    } else {
      composingHunksRef.current.delete(hunkId);
    }
    const wasComposing = isComposingReviewNoteRef.current;
    const nowComposing = composingHunksRef.current.size > 0;
    isComposingReviewNoteRef.current = nowComposing;

    // Update UI state for button disabled state
    setIsRefreshBlocked(nowComposing);

    // If we just stopped composing and there was a pending refresh, flush it
    if (wasComposing && !nowComposing) {
      controllerRef.current?.notifyUnpaused();
    }
  }, []);

  // Track last fetch time for detecting tool completions while unmounted
  const lastFetchTimeRef = useRef(0);

  // Last refresh info for UI display (tooltip showing trigger reason + time)
  const [lastRefreshInfo, setLastRefreshInfo] = useState<LastRefreshInfo | null>(null);
  // Track if refresh button should be disabled (user composing review note)
  const [isRefreshBlocked, setIsRefreshBlocked] = useState(false);

  // RefreshController - handles debouncing, in-flight guards, etc.
  // Created in useEffect to survive React StrictMode double-mount.
  // (StrictMode calls cleanup then re-mounts; refs persist but controller would be disposed)
  const controllerRef = useRef<RefreshController | null>(null);

  useEffect(() => {
    const controller = new RefreshController({
      debounceMs: 3000,
      // Pause scheduled refresh while user is interacting (scrolling, hovering)
      isPaused: () => isInteractingRef.current,
      // Block ALL refresh (including manual) while composing review note
      // This prevents losing work-in-progress when user clicks refresh or presses Ctrl+R
      isManualBlocked: () => isComposingReviewNoteRef.current,
      onRefresh: () => {
        lastFetchTimeRef.current = Date.now();
        setRefreshTrigger((prev) => prev + 1);
        invalidateGitStatus(workspaceId);
      },
      onRefreshComplete: setLastRefreshInfo,
    });
    controllerRef.current = controller;

    // Subscribe to tool completions
    const unsubscribe = workspaceStore.subscribeFileModifyingTool((wsId) => {
      if (wsId === workspaceId) {
        controller.schedule();
      }
    });

    // Check for tool completions that happened while unmounted
    const lastToolMs = workspaceStore.getFileModifyingToolMs(workspaceId);
    if (lastToolMs && lastToolMs > lastFetchTimeRef.current) {
      controller.requestImmediate();
      workspaceStore.clearFileModifyingToolMs(workspaceId);
    }

    return () => {
      unsubscribe();
      controller.dispose();
      controllerRef.current = null;
    };
  }, [workspaceId]);

  const handleRefresh = () => {
    controllerRef.current?.requestImmediate();
  };

  // Sync panel focus with interaction tracking (pauses auto-refresh while user is focused)
  useEffect(() => {
    const wasFocused = isInteractingRef.current;
    isInteractingRef.current = isPanelFocused;

    // If focus was lost, flush any pending refresh that was paused during interaction
    if (wasFocused && !isPanelFocused) {
      controllerRef.current?.notifyUnpaused();
    }
  }, [isPanelFocused]);

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

    const prevRefreshTrigger = lastFileTreeRefreshTriggerRef.current;
    lastFileTreeRefreshTriggerRef.current = refreshTrigger;
    const isManualRefresh = refreshTrigger !== 0 && prevRefreshTrigger !== refreshTrigger;

    const numstatCommand = buildGitDiffCommand(
      filters.diffBase,
      filters.includeUncommitted,
      "", // No path filter for file tree
      "numstat"
    );

    const nameStatusCommand = buildGitDiffCommand(
      filters.diffBase,
      filters.includeUncommitted,
      "", // No path filter for file tree
      "name-status"
    );

    const numstatMarker = "__MUX_REVIEW_FILE_TREE_NUMSTAT__";
    const nameStatusMarker = "__MUX_REVIEW_FILE_TREE_NAME_STATUS__";
    const fileTreeCommand = [
      `echo ${shellQuote(numstatMarker)}`,
      numstatCommand,
      `echo ${shellQuote(nameStatusMarker)}`,
      nameStatusCommand,
    ].join("\n");

    const cacheKey = makeReviewPanelCacheKey({
      workspaceId,
      workspacePath,
      gitCommand: fileTreeCommand,
    });

    // Fast path: use cached tree when switching workspaces (unless user explicitly refreshed
    // or tools completed while we were unmounted).
    if (!isManualRefresh && !skipCacheOnMountRef.current) {
      const cachedTree = reviewPanelCache.get(cacheKey) as FileTreeNode | undefined;
      if (cachedTree) {
        setFileTree(cachedTree);
        setIsLoadingTree(false);
        return () => {
          cancelled = true;
        };
      }
    }

    const loadFileTree = async () => {
      setIsLoadingTree(true);
      try {
        await ensureOriginFetched({
          api,
          workspaceId,
          diffBase: filters.diffBase,
          refreshToken: refreshTrigger,
          originFetchRef,
        });
        if (cancelled) return;

        const tree = await executeWorkspaceBashAndCache({
          api,
          workspaceId,
          script: fileTreeCommand,
          cacheKey,
          timeoutSecs: 30,
          parse: (result) => {
            const output = result.data.output ?? "";

            const marker1 = `${numstatMarker}\n`;
            const marker2 = `${nameStatusMarker}\n`;

            let numstatOutput = output;
            let nameStatusOutput = "";
            const markerSplit = output.split(marker1);
            if (markerSplit.length >= 2) {
              const afterMarker1 = markerSplit[1] ?? "";
              const sections = afterMarker1.split(marker2);
              numstatOutput = sections[0] ?? "";
              nameStatusOutput = sections[1] ?? "";
            }

            const fileStats = parseNumstat(numstatOutput);
            const nameStatus = parseNameStatus(nameStatusOutput);
            const statusByPath = new Map(nameStatus.map((entry) => [entry.filePath, entry]));

            for (const stat of fileStats) {
              const key = extractNewPath(stat.filePath);
              const status = statusByPath.get(key);
              stat.changeType = status?.changeType ?? "modified";
              if (status?.oldPath) {
                stat.oldPath = status.oldPath;
              }
            }

            // Build tree with original paths (needed for git commands)
            return buildFileTree(fileStats);
          },
        });

        if (cancelled) return;
        setFileTree(tree);
      } catch (err) {
        console.error("Failed to load file tree:", err);
      } finally {
        if (!cancelled) {
          setIsLoadingTree(false);
        }
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

    const prevRefreshTrigger = lastDiffRefreshTriggerRef.current;
    lastDiffRefreshTriggerRef.current = refreshTrigger;
    const isManualRefresh = refreshTrigger !== 0 && prevRefreshTrigger !== refreshTrigger;

    const pathFilter = selectedFilePath ? ` -- "${extractNewPath(selectedFilePath)}"` : "";

    const diffCommand = buildGitDiffCommand(
      filters.diffBase,
      filters.includeUncommitted,
      pathFilter,
      "diff"
    );

    const cacheKey = makeReviewPanelCacheKey({
      workspaceId,
      workspacePath,
      gitCommand: diffCommand,
    });

    // Fast path: use cached diff when switching workspaces (unless user explicitly refreshed
    // or tools completed while we were unmounted).
    if (!isManualRefresh && !skipCacheOnMountRef.current) {
      const cached = reviewPanelCache.get(cacheKey) as ReviewPanelDiffCacheValue | undefined;
      if (cached) {
        setDiagnosticInfo(cached.diagnosticInfo);
        setDiffState({
          status: "loaded",
          hunks: cached.hunks,
          truncationWarning: cached.truncationWarning,
        });

        return () => {
          cancelled = true;
        };
      }
    }

    // Clear the skip-cache flag and store timestamp after first load.
    // This prevents re-fetching on every filter change.
    if (skipCacheOnMountRef.current) {
      skipCacheOnMountRef.current = false;
      workspaceStore.clearFileModifyingToolMs(workspaceId);
    }

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
        await ensureOriginFetched({
          api,
          workspaceId,
          diffBase: filters.diffBase,
          refreshToken: refreshTrigger,
          originFetchRef,
        });
        if (cancelled) return;

        // Git-level filters (affect what data is fetched):
        // - diffBase: what to diff against
        // - includeUncommitted: include working directory changes
        // - selectedFilePath: ESSENTIAL for truncation - if full diff is cut off,
        //   path filter lets us retrieve specific file's hunks
        const data = await executeWorkspaceBashAndCache({
          api,
          workspaceId,
          script: diffCommand,
          cacheKey,
          timeoutSecs: 30,
          parse: (result) => {
            const diffOutput = result.data.output ?? "";
            const truncationInfo = "truncated" in result.data ? result.data.truncated : undefined;

            const fileDiffs = parseDiff(diffOutput);
            const allHunks = extractAllHunks(fileDiffs);

            const diagnosticInfo: DiagnosticInfo = {
              command: diffCommand,
              outputLength: diffOutput.length,
              fileDiffCount: fileDiffs.length,
              hunkCount: allHunks.length,
            };

            // Build truncation warning (only when not filtering by path)
            const truncationWarning =
              truncationInfo && !selectedFilePath
                ? `Diff truncated (${truncationInfo.reason}). Filter by file to see more.`
                : null;

            return { hunks: allHunks, truncationWarning, diagnosticInfo };
          },
        });

        if (cancelled) return;

        setDiagnosticInfo(data.diagnosticInfo);

        // Preserve object references for unchanged hunks to prevent unnecessary re-renders.
        // HunkViewer is memoized on hunk object identity, so reusing references avoids
        // re-rendering (and re-highlighting) hunks that haven't actually changed.
        setDiffState((prev) => {
          const prevHunks =
            prev.status === "loaded" || prev.status === "refreshing" ? prev.hunks : [];
          const hunks = preserveHunkReferences(prevHunks, data.hunks);
          return {
            status: "loaded",
            hunks,
            truncationWarning: data.truncationWarning,
          };
        });
      } catch (err) {
        if (cancelled) return;
        const errorMsg = `Failed to load diff: ${err instanceof Error ? err.message : String(err)}`;
        console.error(errorMsg);
        setDiffState({ status: "error", message: errorMsg });
        setDiagnosticInfo(null);
      }
    };

    void loadDiff();

    return () => {
      cancelled = true;
    };
  }, [
    api,
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

  // Persist sortOrder when it changes
  useEffect(() => {
    setSortOrder(filters.sortOrder);
  }, [filters.sortOrder, setSortOrder]);

  // Record first-seen timestamps for new hunks
  useEffect(() => {
    if (hunks.length > 0) {
      recordFirstSeen(hunks.map((h) => h.id));
    }
  }, [hunks, recordFirstSeen]);

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

  // Apply frontend filters (read state, search term) and sorting
  // Note: selectedFilePath is a git-level filter, applied when fetching hunks
  const filteredHunks = useMemo(() => {
    const filtered = applyFrontendFilters(hunks, {
      showReadHunks: filters.showReadHunks,
      isRead,
      searchTerm: debouncedSearchTerm,
      useRegex: searchState.useRegex,
      matchCase: searchState.matchCase,
    });

    // Apply sorting based on sortOrder
    if (filters.sortOrder === "last-edit") {
      // Sort by first-seen timestamp (newest first = LIFO)
      // Hunks without a first-seen record use current time (treated as newest)
      const now = Date.now();
      return [...filtered].sort((a, b) => {
        const aTime = firstSeenMap[a.id] ?? now;
        const bTime = firstSeenMap[b.id] ?? now;
        return bTime - aTime; // Descending (newest first)
      });
    }

    // Default: file-order (maintain original order from git diff)
    return filtered;
  }, [
    hunks,
    filters.showReadHunks,
    filters.sortOrder,
    isRead,
    debouncedSearchTerm,
    searchState.useRegex,
    searchState.matchCase,
    firstSeenMap,
  ]);

  // Keep ref in sync so callbacks can access current filtered list without dependency
  filteredHunksRef.current = filteredHunks;

  // Ensure selectedHunkId is valid after filtering/sorting:
  // - If no selection or selection not in filtered list, select first visible hunk
  // - This runs after sorting, so we always select the top-most hunk in current order
  useEffect(() => {
    if (filteredHunks.length === 0) return;

    const selectionValid = selectedHunkId && filteredHunks.some((h) => h.id === selectedHunkId);
    if (!selectionValid) {
      setSelectedHunkId(filteredHunks[0].id);
    }
  }, [filteredHunks, selectedHunkId, setSelectedHunkId]);

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
  // Uses refs to keep callback stable across state changes - prevents HunkViewer re-renders
  const handleToggleRead = useCallback(
    (hunkId: string) => {
      const wasRead = isReadRef.current(hunkId);
      toggleRead(hunkId);

      // If toggling the selected hunk, check if it will still be visible after toggle
      if (hunkId === selectedHunkIdRef.current) {
        // Hunk is visible if: showReadHunks is on OR it will be unread after toggle
        const willBeVisible = showReadHunksRef.current || wasRead;

        if (!willBeVisible) {
          // Use ref to get current filtered/sorted list for navigation
          setSelectedHunkId(findNextHunkId(filteredHunksRef.current, hunkId));
        }
      }
    },
    [toggleRead, setSelectedHunkId]
  );

  // Handle marking hunk as read with auto-navigation
  // Uses refs to keep callback stable across state changes - prevents HunkViewer re-renders
  const handleMarkAsRead = useCallback(
    (hunkId: string) => {
      const wasRead = isReadRef.current(hunkId);
      markAsRead(hunkId);

      // If marking the selected hunk as read and it will be filtered out, navigate
      if (hunkId === selectedHunkIdRef.current && !wasRead && !showReadHunksRef.current) {
        // Use ref to get current filtered/sorted list for navigation
        setSelectedHunkId(findNextHunkId(filteredHunksRef.current, hunkId));
      }
    },
    [markAsRead, setSelectedHunkId]
  );

  // Handle marking hunk as unread (no navigation needed - unread hunks are always visible)
  const handleMarkAsUnread = useCallback(
    (hunkId: string) => {
      markAsUnread(hunkId);
    },
    [markAsUnread]
  );

  // Stable callbacks for HunkViewer (single callback shared across all hunks)
  const handleHunkClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const hunkId = e.currentTarget.dataset.hunkId;
      if (hunkId) setSelectedHunkId(hunkId);
    },
    [setSelectedHunkId]
  );

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
        // Use ref to get current filtered/sorted list, then find next hunk not in same file
        setSelectedHunkId(
          findNextHunkIdAfterFileRemoval(filteredHunksRef.current, hunkId, hunk.filePath)
        );
      }
    },
    [hunks, markAsRead, filters.showReadHunks, selectedHunkId, setSelectedHunkId]
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

  // Report stats to parent for tab badge
  useEffect(() => {
    onStatsChange?.({ total: stats.total, read: stats.read });
  }, [stats.total, stats.read, onStatsChange]);

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
    setSelectedHunkId,
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
        controllerRef.current?.requestImmediate();
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
        <Loader2 aria-hidden="true" className="text-secondary mb-4 h-6 w-6 animate-spin" />
        <p className="text-secondary text-sm">Setting up workspace...</p>
        <p className="text-secondary mt-1 text-xs">Review will be available once ready</p>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      tabIndex={0}
      data-testid="review-panel"
      onFocus={() => setIsPanelFocused(true)}
      onBlur={() => setIsPanelFocused(false)}
      className="bg-dark [container-type:inline-size] flex h-full min-h-0 flex-col outline-none [container-name:review-panel]"
    >
      {/* Always show controls so user can change diff base */}
      <ReviewControls
        filters={filters}
        stats={stats}
        onFiltersChange={setFilters}
        onRefresh={handleRefresh}
        isLoading={
          diffState.status === "loading" || diffState.status === "refreshing" || isLoadingTree
        }
        isRefreshBlocked={isRefreshBlocked}
        projectPath={projectPath}
        lastRefreshInfo={lastRefreshInfo}
      />

      {diffState.status === "error" ? (
        <div className="text-danger-soft bg-danger-soft/10 border-danger-soft/30 font-monospace m-3 rounded border p-6 text-xs leading-[1.5] break-words whitespace-pre-wrap">
          {diffState.message}
          {/* Show helpful hint when ref doesn't exist */}
          {diffState.message.includes("unknown revision") && (
            <div className="text-muted mt-3 flex items-start gap-2 border-t border-current/20 pt-3 font-sans text-[11px]">
              <Lightbulb aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                The ref <code className="text-foreground">{filters.diffBase}</code> does not exist
                in this repository. Use the dropdown above to select a different base (e.g., HEAD,
                origin/master).
              </span>
            </div>
          )}
        </div>
      ) : diffState.status === "loading" ? (
        <div className="text-muted flex h-full items-center justify-center text-sm">
          Loading diff...
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {diffState.truncationWarning && (
            <div className="bg-warning/10 border-warning/30 text-warning mx-3 my-3 flex items-center gap-1.5 rounded border px-3 py-1.5 text-[10px] leading-[1.3]">
              <AlertTriangle aria-hidden="true" className="h-3 w-3 shrink-0" />
              <span>{diffState.truncationWarning}</span>
            </div>
          )}

          {/* Search bar - always visible at top, not sticky */}
          <div className="border-border-light flex items-center gap-1.5 border-b px-2 py-1">
            <input
              ref={searchInputRef}
              type="text"
              placeholder={`Search... (${formatKeybind(KEYBINDS.FOCUS_REVIEW_SEARCH)})`}
              value={searchState.input}
              onChange={(e) => setSearchState({ ...searchState, input: e.target.value })}
              className="bg-dark text-foreground border-border-medium placeholder:text-dim hover:border-accent focus:border-accent min-w-0 flex-1 rounded border px-1.5 py-0.5 font-mono text-[11px] transition-[border-color] duration-150 focus:outline-none"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    "font-monospace cursor-pointer border-none bg-transparent p-0 text-[11px] font-semibold transition-colors duration-150",
                    searchState.useRegex ? "text-accent-light" : "text-muted hover:text-foreground"
                  )}
                  onClick={() =>
                    setSearchState({ ...searchState, useRegex: !searchState.useRegex })
                  }
                >
                  .*
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {searchState.useRegex ? "Using regex search" : "Using substring search"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    "font-monospace cursor-pointer border-none bg-transparent p-0 text-[11px] font-semibold transition-colors duration-150",
                    searchState.matchCase ? "text-accent-light" : "text-muted hover:text-foreground"
                  )}
                  onClick={() =>
                    setSearchState({ ...searchState, matchCase: !searchState.matchCase })
                  }
                >
                  Aa
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {searchState.matchCase
                  ? "Match case (case-sensitive)"
                  : "Ignore case (case-insensitive)"}
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Single scrollable area containing both file tree and hunks */}
          <div ref={scrollContainerRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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

            {/* Untracked files banner - shown above hunks */}
            <UntrackedStatus
              workspaceId={workspaceId}
              workspacePath={workspacePath}
              refreshTrigger={refreshTrigger}
              onRefresh={handleRefresh}
            />

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
                  // Default to now for hunks without first-seen (e.g., old mux versions)
                  const hunkFirstSeenAt = firstSeenMap[hunk.id] ?? Date.now();

                  return (
                    <HunkViewer
                      key={hunk.id}
                      hunk={hunk}
                      hunkId={hunk.id}
                      workspaceId={workspaceId}
                      inlineReviews={reviewsByFilePath.get(hunk.filePath)}
                      isSelected={isSelected}
                      isRead={hunkIsRead}
                      firstSeenAt={hunkFirstSeenAt}
                      onClick={handleHunkClick}
                      onToggleRead={handleHunkToggleRead}
                      onRegisterToggleExpand={handleRegisterToggleExpand}
                      onReviewNote={onReviewNote}
                      searchConfig={searchConfig}
                      onComposingChange={handleHunkComposingChange}
                      diffBase={filters.diffBase}
                      includeUncommitted={filters.includeUncommitted}
                      reviewActions={reviewActions}
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
