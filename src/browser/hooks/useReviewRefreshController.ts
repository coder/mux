import { useEffect, useRef, useMemo } from "react";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import type { APIClient } from "@/browser/contexts/API";
import {
  RefreshController,
  type LastRefreshInfo,
  type RefreshTrigger,
} from "@/browser/utils/RefreshController";
import { usePersistedState } from "@/browser/hooks/usePersistedState";

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
  /** Info about the last completed refresh (for debugging) */
  lastRefreshInfo: LastRefreshInfo | null;
  /** Call when diff finishes loading to update lastRefreshInfo with correct timing */
  markDiffLoaded: () => void;
}

/**
 * Controls ReviewPanel auto-refresh triggered by file-modifying tool completions.
 *
 * Delegates debouncing, visibility/focus handling, and in-flight guards to RefreshController.
 * Keeps ReviewPanel-specific logic:
 * - Origin branch fetch before refresh
 * - Scroll position preservation
 * - User interaction pause state
 */
export function useReviewRefreshController(
  options: UseReviewRefreshControllerOptions
): ReviewRefreshController {
  const { workspaceId, api, isCreating, scrollContainerRef } = options;

  // Refs for values that executeRefresh needs at call time (avoid stale closures)
  const diffBaseRef = useRef(options.diffBase);
  diffBaseRef.current = options.diffBase;

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

  // Track pending trigger - set when refresh starts, used when diff finishes loading
  const pendingTriggerRef = useRef<RefreshTrigger>("initial");

  // Create RefreshController once, with stable callbacks via refs
  const controller = useMemo(() => {
    const wsName = workspaceStore.getWorkspaceName(workspaceId);
    const ctrl = new RefreshController({
      debounceMs: TOOL_REFRESH_DEBOUNCE_MS,
      isPaused: () => isInteractingRef.current,
      debugLabel: wsName,
      onRefresh: async () => {
        if (!api || isCreating) return;

        // Save scroll position before refresh
        savedScrollTopRef.current = scrollContainerRef.current?.scrollTop ?? null;

        const originBranch = getOriginBranchForFetch(diffBaseRef.current);
        if (originBranch) {
          try {
            await api.workspace.executeBash({
              workspaceId,
              script: `git fetch origin ${originBranch} --quiet || true`,
              options: { timeout_secs: 30 },
            });
          } catch (err) {
            console.debug("ReviewPanel origin fetch failed", err);
          }
        }

        onRefreshRef.current();
        onGitStatusRefreshRef.current?.();
      },
      // Track the trigger so we can use it when diff actually finishes loading
      onRefreshComplete: (info) => {
        pendingTriggerRef.current = info.trigger;
      },
    });
    ctrl.bindListeners();
    return ctrl;
    // workspaceId/api/isCreating changes require new controller with updated closure
    // Note: options.onRefresh is accessed via ref to avoid recreating controller on every render
  }, [workspaceId, api, isCreating, scrollContainerRef]);

  // Cleanup on unmount or when controller changes
  useEffect(() => {
    return () => controller.dispose();
  }, [controller]);

  // Subscribe to file-modifying tool completions
  useEffect(() => {
    if (!api || isCreating) return;

    const wsName = workspaceStore.getWorkspaceName(workspaceId);
    console.debug(`[ReviewRefresh] subscribing for "${wsName}"`);

    const unsubscribe = workspaceStore.subscribeFileModifyingTool(() => {
      console.debug(`[ReviewRefresh] tool completed in "${wsName}", scheduling refresh`);
      controller.schedule();
    }, workspaceId);

    return () => {
      console.debug(`[ReviewRefresh] unsubscribing for "${wsName}"`);
      unsubscribe();
    };
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
    const wsName = workspaceStore.getWorkspaceName(workspaceId);
    console.debug(`[ReviewRefresh] requestManualRefresh for "${wsName}"`);
    controller.requestImmediate();
  };

  // Called by ReviewPanel when diff finishes loading
  const markDiffLoaded = () => {
    setLastRefreshInfo({
      timestamp: Date.now(),
      trigger: pendingTriggerRef.current,
    });
    // Reset to "initial" for next mount
    pendingTriggerRef.current = "initial";
  };

  return {
    requestManualRefresh,
    setInteracting,
    markDiffLoaded,
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
