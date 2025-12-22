/**
 * Generic refresh controller with debouncing, focus/visibility handling, and in-flight guards.
 *
 * Handles common patterns for event-driven refresh:
 * - Debounces rapid trigger events (trailing edge)
 * - Pauses refresh while document is hidden, flushes when visible
 * - Optionally triggers proactive refresh on focus (for catching external changes)
 * - Guards against concurrent refresh operations
 * - Debounces rapid focus/blur cycles
 *
 * Used by GitStatusStore and useReviewRefreshController.
 */

export interface RefreshControllerOptions {
  /** Called to execute the actual refresh. Can be async. */
  onRefresh: () => Promise<void> | void;

  /** Debounce delay for triggered refreshes (ms). Default: 3000 */
  debounceMs?: number;

  /** Priority debounce delay (ms). Used by schedulePriority(). Default: same as debounceMs */
  priorityDebounceMs?: number;

  /**
   * Whether to proactively refresh on focus, not just flush pending.
   * Enable for stores that need to catch external changes (e.g., git status).
   * Default: false (only flush pending refreshes)
   */
  refreshOnFocus?: boolean;

  /** Minimum interval between focus-triggered refreshes (ms). Default: 500 */
  focusDebounceMs?: number;

  /**
   * Optional callback to check if refresh should be paused (e.g., user is interacting).
   * If returns true, refresh is deferred until the condition clears.
   */
  isPaused?: () => boolean;
}

export class RefreshController {
  private readonly onRefresh: () => Promise<void> | void;
  private readonly debounceMs: number;
  private readonly priorityDebounceMs: number;
  private readonly refreshOnFocus: boolean;
  private readonly focusDebounceMs: number;
  private readonly isPaused: (() => boolean) | null;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private pendingBecauseHidden = false;
  private pendingBecauseInFlight = false;
  private pendingBecausePaused = false;
  private lastFocusRefreshMs = 0;
  private disposed = false;

  // Track if listeners are bound (for cleanup)
  private listenersBound = false;
  private boundHandleVisibility: (() => void) | null = null;
  private boundHandleFocus: (() => void) | null = null;

  constructor(options: RefreshControllerOptions) {
    this.onRefresh = options.onRefresh;
    this.debounceMs = options.debounceMs ?? 3000;
    this.priorityDebounceMs = options.priorityDebounceMs ?? this.debounceMs;
    this.refreshOnFocus = options.refreshOnFocus ?? false;
    this.focusDebounceMs = options.focusDebounceMs ?? 500;
    this.isPaused = options.isPaused ?? null;
  }

  /**
   * Schedule a debounced refresh. Multiple calls within debounceMs coalesce.
   */
  schedule(): void {
    this.scheduleWithDelay(this.debounceMs);
  }

  /**
   * Schedule with priority (shorter) debounce. Used for active workspace.
   */
  schedulePriority(): void {
    this.scheduleWithDelay(this.priorityDebounceMs);
  }

  private scheduleWithDelay(delayMs: number): void {
    if (this.disposed) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.tryRefresh();
    }, delayMs);
  }

  /**
   * Request immediate refresh, bypassing debounce and pause checks.
   * Use for manual refresh (user clicked button) which should always execute.
   */
  requestImmediate(): void {
    if (this.disposed) return;

    // Clear any pending debounce
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.tryRefresh({ bypassPause: true });
  }

  /**
   * Attempt refresh, respecting pause conditions.
   */
  private tryRefresh(options?: { bypassPause?: boolean }): void {
    if (this.disposed) return;

    // Hidden → queue for visibility
    if (typeof document !== "undefined" && document.hidden) {
      this.pendingBecauseHidden = true;
      return;
    }

    // Custom pause (e.g., user interacting) → queue for unpause
    // Bypassed for manual refresh (user explicitly requested)
    if (!options?.bypassPause && this.isPaused?.()) {
      this.pendingBecausePaused = true;
      return;
    }

    // In-flight → queue for completion
    if (this.inFlight) {
      this.pendingBecauseInFlight = true;
      return;
    }

    this.executeRefresh();
  }

  /**
   * Execute the refresh, tracking in-flight state.
   */
  private executeRefresh(): void {
    if (this.disposed) return;

    this.inFlight = true;

    const maybePromise = this.onRefresh();

    const onComplete = () => {
      this.inFlight = false;

      // Process any queued refresh
      if (this.pendingBecauseInFlight) {
        this.pendingBecauseInFlight = false;
        // Defer to avoid recursive stack
        setTimeout(() => this.tryRefresh(), 0);
      }
    };

    if (maybePromise instanceof Promise) {
      void maybePromise.finally(onComplete);
    } else {
      onComplete();
    }
  }

  /**
   * Handle focus/visibility return. Call from visibility/focus listeners.
   */
  private handleReturn(): void {
    if (this.disposed) return;
    if (typeof document !== "undefined" && document.hidden) return;

    // Flush pending hidden refresh
    if (this.pendingBecauseHidden) {
      this.pendingBecauseHidden = false;
      this.tryRefresh();
      return; // Don't double-refresh with proactive
    }

    // Proactive refresh on focus (with debounce)
    if (this.refreshOnFocus) {
      const now = Date.now();
      if (now - this.lastFocusRefreshMs >= this.focusDebounceMs) {
        this.lastFocusRefreshMs = now;
        this.tryRefresh();
      }
    }
  }

  /**
   * Notify that a pause condition has cleared (e.g., user stopped interacting).
   * Flushes any pending refresh that was deferred due to isPaused().
   */
  notifyUnpaused(): void {
    if (this.disposed) return;
    if (this.pendingBecausePaused) {
      this.pendingBecausePaused = false;
      this.tryRefresh();
    }
  }

  /**
   * Bind focus/visibility listeners. Call once after construction.
   * Safe to call in non-browser environments (no-op).
   */
  bindListeners(): void {
    if (this.listenersBound) return;
    if (typeof document === "undefined" || typeof window === "undefined") return;

    this.listenersBound = true;

    this.boundHandleVisibility = () => {
      if (document.visibilityState === "visible") {
        this.handleReturn();
      }
    };

    this.boundHandleFocus = () => {
      this.handleReturn();
    };

    document.addEventListener("visibilitychange", this.boundHandleVisibility);
    window.addEventListener("focus", this.boundHandleFocus);
  }

  /**
   * Whether a refresh is currently in-flight.
   */
  get isRefreshing(): boolean {
    return this.inFlight;
  }

  /**
   * Clean up timers and listeners.
   */
  dispose(): void {
    this.disposed = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.listenersBound) {
      if (this.boundHandleVisibility) {
        document.removeEventListener("visibilitychange", this.boundHandleVisibility);
      }
      if (this.boundHandleFocus) {
        window.removeEventListener("focus", this.boundHandleFocus);
      }
      this.listenersBound = false;
    }
  }
}
