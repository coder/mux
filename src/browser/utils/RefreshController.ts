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

/** Reason that triggered a refresh - useful for debugging */
export type RefreshTrigger =
  | "manual" // User clicked refresh button
  | "scheduled" // Debounced tool completion
  | "priority" // Priority debounced (active workspace)
  | "focus" // Window regained focus
  | "visibility" // Tab became visible
  | "unpaused" // Interaction ended, flushing pending
  | "in-flight-followup"; // Queued while previous refresh was running

export interface LastRefreshInfo {
  /** Timestamp of last refresh completion */
  timestamp: number;
  /** What triggered the refresh */
  trigger: RefreshTrigger;
}

export interface RefreshControllerOptions {
  /** Called to execute the actual refresh. Can be async. */
  onRefresh: () => Promise<void> | void;

  /** Called after refresh completes with info about the refresh (for state updates) */
  onRefreshComplete?: (info: LastRefreshInfo) => void;

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

  /** Label for debug logging (e.g., workspace name). If set, enables debug logs. */
  debugLabel?: string;
}

export class RefreshController {
  private readonly onRefresh: () => Promise<void> | void;
  private readonly onRefreshComplete: ((info: LastRefreshInfo) => void) | null;
  private readonly debounceMs: number;
  private readonly priorityDebounceMs: number;
  private readonly refreshOnFocus: boolean;
  private readonly focusDebounceMs: number;
  private readonly isPaused: (() => boolean) | null;
  private readonly debugLabel: string | null;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private pendingBecauseHidden = false;
  private pendingBecauseInFlight = false;
  private pendingBecausePaused = false;
  private lastFocusRefreshMs = 0;
  private disposed = false;

  // Track last refresh for debugging
  private _lastRefreshInfo: LastRefreshInfo | null = null;
  private pendingTrigger: RefreshTrigger | null = null;

  // Track if listeners are bound (for cleanup)
  private listenersBound = false;
  private boundHandleVisibility: (() => void) | null = null;
  private boundHandleFocus: (() => void) | null = null;

  constructor(options: RefreshControllerOptions) {
    this.onRefresh = options.onRefresh;
    this.onRefreshComplete = options.onRefreshComplete ?? null;
    this.debounceMs = options.debounceMs ?? 3000;
    this.priorityDebounceMs = options.priorityDebounceMs ?? this.debounceMs;
    this.refreshOnFocus = options.refreshOnFocus ?? false;
    this.focusDebounceMs = options.focusDebounceMs ?? 500;
    this.isPaused = options.isPaused ?? null;
    this.debugLabel = options.debugLabel ?? null;
  }

  private debug(message: string): void {
    if (this.debugLabel) {
      console.debug(`[RefreshController:${this.debugLabel}] ${message}`);
    }
  }

  /**
   * Schedule a rate-limited refresh. Multiple calls within the rate limit window
   * coalesce, but don't reset the timer (unlike pure debounce).
   *
   * Behavior:
   * - First call starts timer for delayMs
   * - Subsequent calls mark "pending" but don't reset timer
   * - When timer fires, refresh runs
   * - If calls came in during refresh, a new timer starts after completion
   */
  schedule(): void {
    this.scheduleWithDelay(this.debounceMs, "scheduled");
  }

  /**
   * Schedule with priority (shorter) rate limit. Used for active workspace.
   */
  schedulePriority(): void {
    this.scheduleWithDelay(this.priorityDebounceMs, "priority");
  }

  private scheduleWithDelay(delayMs: number, trigger: RefreshTrigger): void {
    if (this.disposed) return;

    // Always update pending trigger (use priority if upgrading from scheduled)
    if (!this.pendingTrigger || trigger === "priority") {
      this.pendingTrigger = trigger;
    }

    // If refresh is in-flight, mark pending and let onComplete handle scheduling
    if (this.inFlight) {
      this.debug("in-flight, queueing for completion");
      this.pendingBecauseInFlight = true;
      return;
    }

    // Rate-limit: if timer already running, don't reset it
    if (this.debounceTimer) {
      this.debug("timer running, coalescing");
      return;
    }

    this.debug(`starting ${delayMs}ms timer (${trigger})`);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const t = this.pendingTrigger ?? trigger;
      this.pendingTrigger = null;
      this.debug(`timer fired, refreshing (${t})`);
      this.tryRefresh({ trigger: t });
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

    this.tryRefresh({ bypassPause: true, trigger: "manual" });
  }

  /**
   * Attempt refresh, respecting pause conditions.
   */
  private tryRefresh(options?: { bypassPause?: boolean; trigger?: RefreshTrigger }): void {
    if (this.disposed) return;

    const trigger = options?.trigger ?? this.pendingTrigger ?? "scheduled";

    // Hidden → queue for visibility
    if (typeof document !== "undefined" && document.hidden) {
      this.pendingBecauseHidden = true;
      this.pendingTrigger = trigger;
      return;
    }

    // Custom pause (e.g., user interacting) → queue for unpause
    // Bypassed for manual refresh (user explicitly requested)
    if (!options?.bypassPause && this.isPaused?.()) {
      this.pendingBecausePaused = true;
      this.pendingTrigger = trigger;
      return;
    }

    // In-flight → queue for completion
    if (this.inFlight) {
      this.pendingBecauseInFlight = true;
      this.pendingTrigger = trigger;
      return;
    }

    this.executeRefresh(trigger);
  }

  /**
   * Execute the refresh, tracking in-flight state.
   */
  private executeRefresh(trigger: RefreshTrigger): void {
    if (this.disposed) return;

    this.inFlight = true;
    this.pendingTrigger = null;

    const maybePromise = this.onRefresh();

    const onComplete = () => {
      this.inFlight = false;
      this._lastRefreshInfo = { timestamp: Date.now(), trigger };

      // Notify listener (for React state updates)
      this.onRefreshComplete?.(this._lastRefreshInfo);

      // Process any queued refresh
      if (this.pendingBecauseInFlight) {
        this.pendingBecauseInFlight = false;
        // Defer to avoid recursive stack; use the queued trigger
        const followupTrigger = this.pendingTrigger ?? "in-flight-followup";
        setTimeout(() => this.tryRefresh({ trigger: followupTrigger }), 0);
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
  private handleReturn(trigger: "focus" | "visibility"): void {
    if (this.disposed) return;
    if (typeof document !== "undefined" && document.hidden) return;

    // Flush pending hidden refresh
    if (this.pendingBecauseHidden) {
      this.pendingBecauseHidden = false;
      this.tryRefresh({ trigger });
      return; // Don't double-refresh with proactive
    }

    // Proactive refresh on focus (with debounce)
    if (this.refreshOnFocus) {
      const now = Date.now();
      if (now - this.lastFocusRefreshMs >= this.focusDebounceMs) {
        this.lastFocusRefreshMs = now;
        this.tryRefresh({ trigger });
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
      this.tryRefresh({ trigger: "unpaused" });
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
        this.handleReturn("visibility");
      }
    };

    this.boundHandleFocus = () => {
      this.handleReturn("focus");
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
   * Info about the last completed refresh (timestamp and trigger reason).
   * Useful for debugging refresh behavior.
   */
  get lastRefreshInfo(): LastRefreshInfo | null {
    return this._lastRefreshInfo;
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
