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

    // Check non-retryable errors using extracted common utils
    if (isNonRetryableSendError(error) || isNonRetryableStreamError(error)) {
      this.onStatusChange({ type: "auto-retry-abandoned", reason: error.type });
      return;
    }

    // If a retry is already pending, cancel it and reschedule with updated backoff.
    // This can happen when multiple error events arrive before the timer fires.
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    this.state = createFailedRetryState(this.state.attempt, error);
    const delay = calculateBackoffDelay(this.state.attempt);

    this.onStatusChange({
      type: "auto-retry-scheduled",
      attempt: this.state.attempt,
      delayMs: delay,
      scheduledAt: Date.now(),
    });

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.onStatusChange({ type: "auto-retry-starting", attempt: this.state.attempt });
      this.onRetry().catch((retryError: unknown) => {
        const reason =
          retryError instanceof Error && retryError.message.length > 0
            ? retryError.message
            : "retry_callback_failed";
        this.onStatusChange({ type: "auto-retry-abandoned", reason });
      });
    }, delay);
  }

  handleStreamSuccess(): void {
    this.state = createFreshRetryState<RetryFailureError>();
  }

  cancel(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.retryTimer = null;
    this.state = createFreshRetryState<RetryFailureError>();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      // Cancel any pending retry and notify the frontend so the UI clears
      // the retry status (e.g., "Retrying…" or countdown).
      if (this.retryTimer !== null) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.onStatusChange({ type: "auto-retry-abandoned", reason: "disabled_by_user" });
      }
      this.state = createFreshRetryState<RetryFailureError>();
    }
  }

  get isRetryPending(): boolean {
    return this.retryTimer !== null;
  }

  dispose(): void {
    this.cancel();
  }
}
