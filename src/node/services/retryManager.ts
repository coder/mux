import assert from "@/common/utils/assert";
import {
  calculateBackoffDelay,
  createFailedRetryState,
  createFreshRetryState,
  type RetryState,
} from "@/common/utils/messages/retryState";
import {
  isNonRetryableSendError,
  isNonRetryableStreamError,
} from "@/common/utils/messages/retryEligibility";

export interface RetryFailureError {
  type: string;
  message?: string;
}

// Status events emitted during auto-retry lifecycle
export interface AutoRetryScheduledEvent {
  type: "auto-retry-scheduled";
  attempt: number;
  delayMs: number;
  scheduledAt: number;
}
export interface AutoRetryStartingEvent {
  type: "auto-retry-starting";
  attempt: number;
}
export interface AutoRetryAbandonedEvent {
  type: "auto-retry-abandoned";
  reason: string;
}
export type RetryStatusEvent =
  | AutoRetryScheduledEvent
  | AutoRetryStartingEvent
  | AutoRetryAbandonedEvent;

export class RetryManager {
  private state: RetryState<RetryFailureError>;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private enabled = true;
  private retryGeneration = 0;
  private pendingScheduledEvent: AutoRetryScheduledEvent | null = null;

  constructor(
    private readonly workspaceId: string,
    private readonly onRetry: () => Promise<void>,
    private readonly onStatusChange: (event: RetryStatusEvent) => void
  ) {
    assert(this.workspaceId.trim().length > 0, "RetryManager: workspaceId must be non-empty");
    assert(typeof this.onRetry === "function", "RetryManager: onRetry must be a function");
    assert(
      typeof this.onStatusChange === "function",
      "RetryManager: onStatusChange must be a function"
    );

    this.state = createFreshRetryState<RetryFailureError>();
  }

  handleStreamFailure(error: RetryFailureError): void {
    assert(
      typeof error.type === "string" && error.type.length > 0,
      "RetryManager: error.type required"
    );

    if (!this.enabled) {
      return;
    }

    // Check non-retryable errors using extracted common utils.
    // Cancel any pending retry first — a retryable error may have scheduled
    // a timer, but a later non-retryable error supersedes it.
    if (isNonRetryableSendError(error) || isNonRetryableStreamError(error)) {
      this.cancelPendingTimer();
      this.pendingScheduledEvent = null;
      this.retryGeneration += 1;
      this.onStatusChange({ type: "auto-retry-abandoned", reason: error.type });
      return;
    }

    // If a retry is already pending, cancel it and reschedule with updated backoff.
    // This can happen when multiple error events arrive before the timer fires.
    this.cancelPendingTimer();

    this.state = createFailedRetryState(this.state.attempt, error);
    const delay = calculateBackoffDelay(this.state.attempt);
    this.retryGeneration += 1;
    const scheduledGeneration = this.retryGeneration;

    const scheduledEvent: AutoRetryScheduledEvent = {
      type: "auto-retry-scheduled",
      attempt: this.state.attempt,
      delayMs: delay,
      scheduledAt: Date.now(),
    };
    this.pendingScheduledEvent = scheduledEvent;
    this.onStatusChange(scheduledEvent);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pendingScheduledEvent = null;

      // Guard against stale timers or stop requests that race with callback execution.
      if (!this.enabled || scheduledGeneration !== this.retryGeneration) {
        return;
      }

      this.onStatusChange({ type: "auto-retry-starting", attempt: this.state.attempt });

      // Re-check after status emission so a synchronous stop handler can cancel
      // before we attempt to resume the stream.
      if (!this.enabled || scheduledGeneration !== this.retryGeneration) {
        return;
      }

      this.onRetry().catch((retryError: unknown) => {
        // Ignore stale retry callbacks from superseded/disabled generations.
        if (!this.enabled || scheduledGeneration !== this.retryGeneration) {
          return;
        }

        const reason =
          retryError instanceof Error && retryError.message.length > 0
            ? retryError.message
            : "retry_callback_failed";
        this.onStatusChange({ type: "auto-retry-abandoned", reason });
      });
    }, delay);
  }

  handleStreamSuccess(): void {
    // Cancel any stale retry timer (e.g., if a manual retry succeeded
    // before the scheduled timer fired) and reset state.
    this.cancel();
  }

  /** Cancel any pending retry timer without resetting state. */
  private cancelPendingTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  cancel(): void {
    this.cancelPendingTimer();
    this.pendingScheduledEvent = null;
    this.retryGeneration += 1;
    this.state = createFreshRetryState<RetryFailureError>();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      // Cancel any pending/in-flight retry and notify the frontend so the UI
      // clears the retry status (e.g., "Retrying…" or countdown).
      // Check state.attempt rather than isRetryPending because the timer may
      // have already fired (retryTimer is null) while the onRetry callback is
      // still executing — the UI would otherwise remain stuck in retry state.
      const hadActiveRetry = this.isRetryPending || this.state.attempt > 0;
      this.cancel();
      if (hadActiveRetry) {
        this.onStatusChange({ type: "auto-retry-abandoned", reason: "disabled_by_user" });
      }
    }
  }

  get isRetryPending(): boolean {
    return this.retryTimer !== null;
  }

  getScheduledStatusSnapshot(): AutoRetryScheduledEvent | null {
    if (!this.pendingScheduledEvent) {
      return null;
    }

    // Return a copy so callers cannot mutate internal retry state.
    return { ...this.pendingScheduledEvent };
  }

  dispose(): void {
    this.cancel();
  }
}
