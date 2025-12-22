import { useEffect, useRef } from "react";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import type { APIClient } from "@/browser/contexts/API";

/** Debounce delay for auto-refresh after tool completion */
const TOOL_REFRESH_DEBOUNCE_MS = 3000;

/**
 * Extract branch name from an "origin/..." diff base for git fetch.
 * Returns null if not an origin ref or if branch name is unsafe for shell.
 */
function getOriginBranchForFetch(diffBase: string): string | null {
  const trimmed = diffBase.trim();
  if (!trimmed.startsWith("origin/")) return null;

  const branch = trimmed.slice("origin/".length);

  // Avoid shell injection; diffBase is user-controlled.
  if (!/^[0-9A-Za-z._/-]+$/.test(branch)) return null;

  return branch;
}

export interface UseReviewRefreshControllerOptions {
  workspaceId: string;
  api: APIClient | null;
  isCreating: boolean;
  /** Current diff base (e.g. "HEAD", "origin/main") - read at execution time via ref */
  diffBase: string;
  /** Called when a refresh should occur (increment refreshTrigger) */
  onRefresh: () => void;
  /** Ref to scroll container for preserving scroll position */
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  /** Optional: called after refresh to trigger git status update */
  onGitStatusRefresh?: () => void;
}

export interface ReviewRefreshController {
  /** Trigger a manual refresh (from button/keybind) */
  requestManualRefresh: () => void;
  /** Set whether user is actively interacting (pauses auto-refresh) */
  setInteracting: (interacting: boolean) => void;
  /** Whether a git fetch is currently in-flight */
  isRefreshing: boolean;
}

/**
 * Controls ReviewPanel auto-refresh triggered by file-modifying tool completions.
 *
 * Handles:
 * - Debouncing rapid tool completions (3s window)
 * - Pausing while user is interacting (review note input focused)
 * - Pausing while tab is hidden (flush on visibility change)
 * - Coalescing requests while origin fetch is in-flight
 * - Preserving scroll position across refreshes
 *
 * Architecture:
 * - All refresh logic flows through a single ref-based handler to avoid stale closures
 * - Pending flags track deferred refreshes for various pause conditions
 * - visibilitychange listener ensures hidden-tab refreshes aren't lost
 */
export function useReviewRefreshController(
  options: UseReviewRefreshControllerOptions
): ReviewRefreshController {
  const { workspaceId, api, isCreating, onRefresh, scrollContainerRef, onGitStatusRefresh } =
    options;

  // Store diffBase in a ref so we always read the latest value
  const diffBaseRef = useRef(options.diffBase);
  diffBaseRef.current = options.diffBase;

  // Store onGitStatusRefresh in a ref to avoid stale closures
  const onGitStatusRefreshRef = useRef(onGitStatusRefresh);
  onGitStatusRefreshRef.current = onGitStatusRefresh;

  // State refs (avoid re-renders, just track state for refresh logic)
  const isRefreshingRef = useRef(false);
  const isInteractingRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pending flags - track why refresh was deferred
  const pendingBecauseHiddenRef = useRef(false);
  const pendingBecauseInteractingRef = useRef(false);
  const pendingBecauseInFlightRef = useRef(false);

  // Scroll position to restore after refresh
  const savedScrollTopRef = useRef<number | null>(null);

  // Expose isRefreshing for UI (e.g. disable refresh button)
  // We use a ref but also track in a simple way for the return value
  const isRefreshingForReturn = useRef(false);

  /**
   * Core refresh execution - handles origin fetch if needed, then triggers onRefresh.
   * Always reads latest state from refs at execution time.
   */
  const executeRefresh = useRef(() => {
    if (!api || isCreating) return;

    // Save scroll position before refresh
    savedScrollTopRef.current = scrollContainerRef.current?.scrollTop ?? null;

    const originBranch = getOriginBranchForFetch(diffBaseRef.current);
    if (originBranch) {
      isRefreshingRef.current = true;
      isRefreshingForReturn.current = true;

      api.workspace
        .executeBash({
          workspaceId,
          script: `git fetch origin ${originBranch} --quiet || true`,
          options: { timeout_secs: 30 },
        })
        .catch((err) => {
          console.debug("ReviewPanel origin fetch failed", err);
        })
        .finally(() => {
          isRefreshingRef.current = false;
          isRefreshingForReturn.current = false;
          onRefresh();
          onGitStatusRefreshRef.current?.();

          // If another refresh was requested while we were fetching, do it now
          if (pendingBecauseInFlightRef.current) {
            pendingBecauseInFlightRef.current = false;
            // Use setTimeout to avoid recursive call stack
            setTimeout(() => tryRefresh("in-flight-followup"), 0);
          }
        });

      return;
    }

    // Local base - just trigger refresh immediately
    onRefresh();
    onGitStatusRefreshRef.current?.();
  });

  // Update executeRefresh closure dependencies
  executeRefresh.current = () => {
    if (!api || isCreating) return;

    savedScrollTopRef.current = scrollContainerRef.current?.scrollTop ?? null;

    const originBranch = getOriginBranchForFetch(diffBaseRef.current);
    if (originBranch) {
      isRefreshingRef.current = true;
      isRefreshingForReturn.current = true;

      api.workspace
        .executeBash({
          workspaceId,
          script: `git fetch origin ${originBranch} --quiet || true`,
          options: { timeout_secs: 30 },
        })
        .catch((err) => {
          console.debug("ReviewPanel origin fetch failed", err);
        })
        .finally(() => {
          isRefreshingRef.current = false;
          isRefreshingForReturn.current = false;
          onRefresh();
          onGitStatusRefreshRef.current?.();

          if (pendingBecauseInFlightRef.current) {
            pendingBecauseInFlightRef.current = false;
            setTimeout(() => tryRefresh("in-flight-followup"), 0);
          }
        });

      return;
    }

    onRefresh();
    onGitStatusRefreshRef.current?.();
  };

  /**
   * Attempt to refresh, respecting all pause conditions.
   * If paused, sets the appropriate pending flag.
   */
  const tryRefresh = (_reason: string) => {
    if (!api || isCreating) return;

    // Check pause conditions in order of priority

    // 1. Tab hidden - queue for visibility change
    if (document.hidden) {
      pendingBecauseHiddenRef.current = true;
      return;
    }

    // 2. User interacting - queue for blur
    if (isInteractingRef.current) {
      pendingBecauseInteractingRef.current = true;
      return;
    }

    // 3. Already refreshing (origin fetch in-flight) - queue for completion
    if (isRefreshingRef.current) {
      pendingBecauseInFlightRef.current = true;
      return;
    }

    // All clear - execute refresh
    executeRefresh.current();
  };

  /**
   * Schedule a debounced refresh (for tool completions).
   */
  const scheduleRefresh = () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      tryRefresh("tool-completion");
    }, TOOL_REFRESH_DEBOUNCE_MS);
  };

  /**
   * Flush any pending refresh (called when pause condition clears).
   */
  const flushPending = (clearedCondition: "hidden" | "interacting") => {
    if (clearedCondition === "hidden" && pendingBecauseHiddenRef.current) {
      pendingBecauseHiddenRef.current = false;
      tryRefresh("visibility-restored");
    } else if (clearedCondition === "interacting" && pendingBecauseInteractingRef.current) {
      pendingBecauseInteractingRef.current = false;
      tryRefresh("interaction-ended");
    }
  };

  // Subscribe to file-modifying tool completions
  useEffect(() => {
    if (!api || isCreating) return;

    const unsubscribe = workspaceStore.subscribeFileModifyingTool(scheduleRefresh, workspaceId);

    return () => {
      unsubscribe();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
    // scheduleRefresh is stable (only uses refs internally)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, workspaceId, isCreating]);

  // Handle visibility/focus changes - flush pending refresh when user returns.
  // Uses both visibilitychange (for browser tab hidden state) and window focus
  // (for Electron app focus) since visibilitychange alone is unreliable in Electron
  // when the app is behind other windows or on a different desktop/space.
  useEffect(() => {
    const handleReturn = () => {
      // Only flush if document is actually visible
      if (!document.hidden) {
        flushPending("hidden");
      }
    };

    document.addEventListener("visibilitychange", handleReturn);
    window.addEventListener("focus", handleReturn);
    return () => {
      document.removeEventListener("visibilitychange", handleReturn);
      window.removeEventListener("focus", handleReturn);
    };
    // flushPending is stable (only uses refs internally)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Public API
  const setInteracting = (interacting: boolean) => {
    const wasInteracting = isInteractingRef.current;
    isInteractingRef.current = interacting;

    // If interaction ended, flush any pending refresh
    if (wasInteracting && !interacting) {
      flushPending("interacting");
    }
  };

  const requestManualRefresh = () => {
    // Manual refresh bypasses debounce but still respects in-flight check
    if (isRefreshingRef.current) {
      pendingBecauseInFlightRef.current = true;
      return;
    }
    executeRefresh.current();
  };

  return {
    requestManualRefresh,
    setInteracting,
    get isRefreshing() {
      return isRefreshingForReturn.current;
    },
  };
}

/**
 * Hook to restore scroll position after refresh completes.
 * Call this in the component that owns the scroll container.
 */
export function useRestoreScrollAfterRefresh(
  scrollContainerRef: React.RefObject<HTMLElement | null>,
  savedScrollTopRef: React.MutableRefObject<number | null>,
  isLoaded: boolean
): void {
  useEffect(() => {
    if (isLoaded && savedScrollTopRef.current !== null && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = savedScrollTopRef.current;
      savedScrollTopRef.current = null;
    }
  }, [isLoaded, scrollContainerRef, savedScrollTopRef]);
}
