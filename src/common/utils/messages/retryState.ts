import assert from "@/common/utils/assert";
import type { SendMessageError } from "@/common/types/errors";

export interface RetryState<TError = SendMessageError> {
  attempt: number;
  retryStartTime: number;
  lastError?: TError;
}

export const INITIAL_DELAY = 1000; // 1 second
export const MAX_DELAY = 60000; // 60 seconds

/**
 * Utility functions for managing retry state.
 *
 * These functions encapsulate retry state transitions to prevent bugs
 * like bypassing exponential backoff.
 */

/**
 * Calculate exponential backoff delay with capped maximum.
 *
 * Formula: min(INITIAL_DELAY * 2^attempt, MAX_DELAY)
 * Examples: 1s → 2s → 4s → 8s → 16s → 32s → 60s (capped)
 */
export function calculateBackoffDelay(attempt: number): number {
  assert(Number.isInteger(attempt) && attempt >= 0, "calculateBackoffDelay: attempt must be >= 0");

  const exponentialDelay = INITIAL_DELAY * 2 ** attempt;
  return Math.min(exponentialDelay, MAX_DELAY);
}

/**
 * Create a fresh retry state (for new stream starts).
 *
 * Use this when a stream starts successfully - resets backoff completely.
 */
export function createFreshRetryState<TError = SendMessageError>(): RetryState<TError> {
  return {
    attempt: 0,
    retryStartTime: Date.now(),
  };
}

/**
 * Create retry state after a failed attempt.
 *
 * Increments attempt counter and records the error for display.
 *
 * @param previousAttempt - Previous attempt count
 * @param error - Error that caused the failure
 */
export function createFailedRetryState<TError>(
  previousAttempt: number,
  error: TError
): RetryState<TError> {
  assert(
    Number.isInteger(previousAttempt) && previousAttempt >= 0,
    "createFailedRetryState: previousAttempt must be >= 0"
  );

  return {
    attempt: previousAttempt + 1,
    retryStartTime: Date.now(),
    lastError: error,
  };
}
