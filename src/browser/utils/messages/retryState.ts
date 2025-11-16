import type { RetryState } from "@/browser/hooks/useResumeManager";

export const INITIAL_DELAY = 1000; // 1 second
export const MAX_DELAY = 60000; // 60 seconds

/**
 * Utility functions for managing retry state
 *
 * These functions encapsulate retry state transitions to prevent bugs
 * like bypassing exponential backoff.
 */

/**
 * Calculate exponential backoff delay with capped maximum
 *
 * Formula: min(INITIAL_DELAY * 2^attempt, MAX_DELAY)
 * Examples: 1s → 2s → 4s → 8s → 16s → 32s → 60s (capped)
 */
export function calculateBackoffDelay(attempt: number): number {
  const exponentialDelay = INITIAL_DELAY * Math.pow(2, attempt);
  return Math.min(exponentialDelay, MAX_DELAY);
}

/**
 * Create a fresh retry state (for new stream starts)
 *
 * Use this when a stream starts successfully - resets backoff completely.
 */
export function createFreshRetryState(): RetryState {
  return {
    attempt: 0,
    retryStartTime: Date.now(),
  };
}

/**
 * Create retry state for manual retry (user-initiated)
 *
 * Makes the retry immediately eligible BUT preserves the attempt counter
 * to maintain backoff progression if the retry fails.
 *
 * This prevents infinite retry loops without backoff.
 *
 * @param currentAttempt - Current attempt count to preserve backoff progression
 */
export function createManualRetryState(currentAttempt: number): RetryState {
  return {
    attempt: currentAttempt,
    retryStartTime: Date.now() - INITIAL_DELAY, // Make immediately eligible
    lastError: undefined, // Clear error (user is manually retrying)
  };
}

/**
 * Create retry state after a failed attempt
 *
 * Increments attempt counter and records the error for display.
 *
 * @param previousAttempt - Previous attempt count
 * @param error - Error that caused the failure
 */
export function createFailedRetryState(
  previousAttempt: number,
  error: RetryState["lastError"]
): RetryState {
  return {
    attempt: previousAttempt + 1,
    retryStartTime: Date.now(),
    lastError: error,
  };
}
