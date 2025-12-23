import { useEffect, useRef, useMemo } from "react";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import type { APIClient } from "@/browser/contexts/API";
import { RefreshController, type LastRefreshInfo } from "@/browser/utils/RefreshController";
import { usePersistedState } from "@/browser/hooks/usePersistedState";

/** Debounce delay for auto-refresh after tool completion */
const TOOL_REFRESH_DEBOUNCE_MS = 3000;

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
  /** Info about the last completed refresh (for debugging) */
  lastRefreshInfo: LastRefreshInfo | null;
}

/**
 * Controls ReviewPanel auto-refresh triggered by file-modifying tool completions.
 *
 * Delegates debouncing, visibility/focus handling, and in-flight guards to RefreshController.
 * Keeps ReviewPanel-specific logic:
 * - Scroll position preservation
 * - User interaction pause state
 */
export function useReviewRefreshController(
  options: UseReviewRefreshControllerOptions
): ReviewRefreshController {
  const { workspaceId, api, isCreating, scrollContainerRef } = options;

  // Refs for values that executeRefresh needs at call time (avoid stale closures)
  const onRefreshRef = useRef(options.onRefresh);
  onRefreshRef.current = options.onRefresh;

  const onGitStatusRefreshRef = useRef(options.onGitStatusRefresh);
  onGitStatusRefreshRef.current = options.onGitStatusRefresh;

  // Scroll position to restore after refresh
  const savedScrollTopRef = useRef<number | null>(null);

  // User interaction state (pauses auto-refresh)
  const isInteractingRef = useRef(false);

  // Track last refresh info - persisted per workspace so it survives workspace switches
  const [lastRefreshInfo, setLastRefreshInfo] = usePersistedState<LastRefreshInfo | null>(
    `review-last-refresh:${workspaceId}`,
    null
  );

  // Create RefreshController once, with stable callbacks via refs
  const controller = useMemo(() => {
    const ctrl = new RefreshController({
      debounceMs: TOOL_REFRESH_DEBOUNCE_MS,
      isPaused: () => isInteractingRef.current,
      onRefresh: () => {
        if (isCreating) return;

        // Save scroll position before refresh
        savedScrollTopRef.current = scrollContainerRef.current?.scrollTop ?? null;

        onRefreshRef.current();
        onGitStatusRefreshRef.current?.();
      },
      onRefreshComplete: setLastRefreshInfo,
    });
    ctrl.bindListeners();
    return ctrl;
    // isCreating/scrollContainerRef/setLastRefreshInfo changes require a new controller.
    // Note: options.onRefresh is accessed via ref to avoid recreating controller on every render.
  }, [isCreating, scrollContainerRef, setLastRefreshInfo]);

  // Cleanup on unmount or when controller changes
  useEffect(() => {
    return () => controller.dispose();
  }, [controller]);

  // Subscribe to file-modifying tool completions
  useEffect(() => {
    if (!api || isCreating) return;

    const unsubscribe = workspaceStore.subscribeFileModifyingTool(() => {
      controller.schedule();
    }, workspaceId);

    return unsubscribe;
  }, [api, workspaceId, isCreating, controller]);

  // Public API
  const setInteracting = (interacting: boolean) => {
    const wasInteracting = isInteractingRef.current;
    isInteractingRef.current = interacting;

    // If interaction ended, flush any pending refresh
    if (wasInteracting && !interacting) {
      controller.notifyUnpaused();
    }
  };

  const requestManualRefresh = () => {
    controller.requestImmediate();
  };

  return {
    requestManualRefresh,
    setInteracting,
    get isRefreshing() {
      return controller.isRefreshing;
    },
    lastRefreshInfo,
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
