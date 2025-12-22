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

  /**
   * Whether to proactively refresh on focus, not just flush pending.
   * Enable for stores that need to catch external changes (e.g., git status).
   * Default: false (only flush pending refreshes)
   */
  refreshOnFocus?: boolean;

  /** Minimum interval between focus-triggered refreshes (ms). Default: 500 */
  focusDebounceMs?: number;
}

export class RefreshController {
  private readonly onRefresh: () => Promise<void> | void;
  private readonly debounceMs: number;
  private readonly refreshOnFocus: boolean;
  private readonly focusDebounceMs: number;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private pendingBecauseHidden = false;
  private pendingBecauseInFlight = false;
  private lastFocusRefreshMs = 0;
  private disposed = false;

  // Track if listeners are bound (for cleanup)
  private listenersBound = false;
  private boundHandleVisibility: (() => void) | null = null;
  private boundHandleFocus: (() => void) | null = null;

  constructor(options: RefreshControllerOptions) {
    this.onRefresh = options.onRefresh;
    this.debounceMs = options.debounceMs ?? 3000;
    this.refreshOnFocus = options.refreshOnFocus ?? false;
    this.focusDebounceMs = options.focusDebounceMs ?? 500;
  }

  /**
   * Schedule a debounced refresh. Multiple calls within debounceMs coalesce.
   */
  schedule(): void {
    if (this.disposed) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.tryRefresh();
    }, this.debounceMs);
  }

  /**
   * Request immediate refresh, bypassing debounce but respecting in-flight guard.
   */
  requestImmediate(): void {
    if (this.disposed) return;

    // Clear any pending debounce
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.tryRefresh();
  }

  /**
   * Attempt refresh, respecting pause conditions.
   */
  private tryRefresh(): void {
    if (this.disposed) return;

    // Hidden → queue for visibility
    if (typeof document !== "undefined" && document.hidden) {
      this.pendingBecauseHidden = true;
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
