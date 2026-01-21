import type { DisplayedMessage } from "@/common/types/message";
import type { StreamErrorType, SendMessageError } from "@/common/types/errors";
import type { RuntimeStatusEvent, StreamAbortReasonSnapshot } from "@/common/types/stream";

/**
 * Debug flag to force all errors to be retryable
 * Set in browser console: window.__MUX_FORCE_ALL_RETRYABLE = true
 *
 * Useful for testing retry/backoff logic without needing to simulate
 * specific network conditions or rate limits.
 *
 * Note: If you set this flag after an error occurs, you may need to
 * trigger a manual retry first (click "Retry" button) to clear the
 * stored non-retryable error state.
 */
declare global {
  interface Window {
    __MUX_FORCE_ALL_RETRYABLE?: boolean;
  }
}

export const PENDING_STREAM_START_GRACE_PERIOD_MS = 15000; // 15 seconds

/**
 * Check if the debug flag to force all errors to be retryable is enabled
 */
function isForceAllRetryableEnabled(): boolean {
  return typeof window !== "undefined" && window.__MUX_FORCE_ALL_RETRYABLE === true;
}

/**
 * Error types that should NOT be auto-retried because they require user action
 * These errors won't resolve on their own - the user must fix the underlying issue
 */
const NON_RETRYABLE_STREAM_ERRORS: StreamErrorType[] = [
  "authentication", // Bad API key - user must fix credentials
  "quota", // Billing/usage limits - user must upgrade or wait for reset
  "model_not_found", // Invalid model - user must select different model
  "context_exceeded", // Message too long - user must reduce context
  "aborted", // User cancelled - should not auto-retry
  "runtime_not_ready", // Container/runtime unavailable - permanent failure
];

/**
 * Check if a SendMessageError (from resumeStream failures) is non-retryable
 */
export function isNonRetryableSendError(error: SendMessageError): boolean {
  // Debug flag: force all errors to be retryable
  if (isForceAllRetryableEnabled()) {
    return false;
  }

  switch (error.type) {
    case "api_key_not_found": // Missing API key - user must configure
    case "provider_not_supported": // Unsupported provider - user must switch
    case "invalid_model_string": // Bad model format - user must fix
    case "incompatible_workspace": // Workspace from newer mux version - user must upgrade
    case "runtime_not_ready": // Container doesn't exist - user must recreate workspace
      return true;
    case "runtime_start_failed": // Runtime is starting - transient, worth retrying
    case "unknown":
      return false; // Transient errors might resolve on their own
  }
}

interface InterruptionContext {
  hasInterruptedStream: boolean;
  isEligibleForAutoRetry: boolean;
}

function shouldSuppressAutoRetry(
  lastAbortReason: StreamAbortReasonSnapshot | null | undefined
): boolean {
  return lastAbortReason?.reason === "user" || lastAbortReason?.reason === "startup";
}

/**
 * Check if messages contain an interrupted stream
 *
 * Used by AIView to determine if RetryBarrier should be shown.
 * Shows retry UI for ALL interrupted streams, including non-retryable errors
 * (so users can manually retry after fixing the issue).
 *
 * Returns true if:
 * 1. Last message is a stream-error (any type - user may have fixed the issue)
 * 2. Last message is a partial assistant/tool/reasoning message
 * 3. Last message is a user message (indicating we sent it but never got a response)
 *    - This handles app restarts during slow model responses (models can take 30-60s to first token)
 *    - User messages are only at the end when response hasn't started/completed
 *    - EXCEPT: Not if recently sent (within PENDING_STREAM_START_GRACE_PERIOD_MS) - prevents flash during normal send flow
 */
function computeHasInterruptedStream(
  messages: DisplayedMessage[],
  pendingStreamStartTime: number | null = null,
  runtimeStatus: RuntimeStatusEvent | null = null
): boolean {
  if (messages.length === 0) return false;

  // Don't show retry barrier if user message was sent very recently (within the grace period)
  // This prevents flash during normal send flow while stream-start event arrives
  // After the grace period, assume something is wrong and show the barrier
  if (pendingStreamStartTime !== null) {
    const elapsed = Date.now() - pendingStreamStartTime;
    if (elapsed < PENDING_STREAM_START_GRACE_PERIOD_MS) return false;
  }

  const lastMessage = messages[messages.length - 1];

  // Don't show retry barrier if workspace init is still running AND no error has occurred yet.
  // The backend waits for init to complete before starting the stream.
  // However, if a stream-error already exists, we should show retry (init timeout or other failure).
  const initMessage = messages.find((m) => m.type === "workspace-init");
  if (
    initMessage?.type === "workspace-init" &&
    initMessage.status === "running" &&
    lastMessage.type !== "stream-error"
  ) {
    return false;
  }

  // Don't show retry barrier if runtime is still starting (e.g., Coder workspace waiting for startup scripts).
  // The backend's ensureReady() is still running - this happens when reconnecting to a stopped workspace.
  // runtimeStatus is set during ensureReady() and cleared when ready/error.
  if (runtimeStatus !== null && lastMessage.type !== "stream-error") {
    return false;
  }

  // ask_user_question is a special case: an unfinished tool call represents an
  // intentional "waiting for user input" state, not a stream interruption.
  //
  // Treating it as interrupted causes RetryBarrier + auto-resume to fire on app
  // restart, which re-runs the LLM call and re-asks the questions.
  if (
    lastMessage.type === "tool" &&
    lastMessage.toolName === "ask_user_question" &&
    lastMessage.status === "executing"
  ) {
    return false;
  }

  return (
    lastMessage.type === "stream-error" || // Stream errored out (show UI for ALL error types)
    lastMessage.type === "user" || // No response received yet (app restart during slow model)
    (lastMessage.type === "assistant" && lastMessage.isPartial === true) ||
    (lastMessage.type === "tool" && lastMessage.isPartial === true) ||
    (lastMessage.type === "reasoning" && lastMessage.isPartial === true)
  );
}

/**
 * Shared interruption + retry eligibility helper.
 */
export function getInterruptionContext(
  messages: DisplayedMessage[],
  pendingStreamStartTime: number | null = null,
  runtimeStatus: RuntimeStatusEvent | null = null,
  lastAbortReason: StreamAbortReasonSnapshot | null = null
): InterruptionContext {
  const hasInterrupted = computeHasInterruptedStream(
    messages,
    pendingStreamStartTime,
    runtimeStatus
  );

  if (!hasInterrupted) {
    return { hasInterruptedStream: false, isEligibleForAutoRetry: false };
  }

  if (shouldSuppressAutoRetry(lastAbortReason)) {
    return { hasInterruptedStream: true, isEligibleForAutoRetry: false };
  }

  const lastMessage = messages[messages.length - 1];
  if (lastMessage.type === "stream-error") {
    // Debug flag: force all errors to be retryable
    if (isForceAllRetryableEnabled()) {
      return { hasInterruptedStream: true, isEligibleForAutoRetry: true };
    }
    return {
      hasInterruptedStream: true,
      isEligibleForAutoRetry: !NON_RETRYABLE_STREAM_ERRORS.includes(lastMessage.errorType),
    };
  }

  // Other interrupted states (partial messages, user messages) are auto-retryable
  return { hasInterruptedStream: true, isEligibleForAutoRetry: true };
}

export function hasInterruptedStream(
  messages: DisplayedMessage[],
  pendingStreamStartTime: number | null = null,
  runtimeStatus: RuntimeStatusEvent | null = null,
  lastAbortReason: StreamAbortReasonSnapshot | null = null
): boolean {
  return getInterruptionContext(messages, pendingStreamStartTime, runtimeStatus, lastAbortReason)
    .hasInterruptedStream;
}

/**
 * Check if messages are eligible for automatic retry
 *
 * Used by useResumeManager to determine if workspace should be auto-retried.
 * Returns false for errors that require user action (authentication, quota, etc.),
 * but still allows manual retry via RetryBarrier UI.
 *
 * This separates auto-retry logic from manual retry UI:
 * - Manual retry: Always available for any error (hasInterruptedStream)
 * - Auto retry: Only for transient errors that might resolve on their own
 */
export function isEligibleForAutoRetry(
  messages: DisplayedMessage[],
  pendingStreamStartTime: number | null = null,
  runtimeStatus: RuntimeStatusEvent | null = null,
  lastAbortReason: StreamAbortReasonSnapshot | null = null
): boolean {
  return getInterruptionContext(messages, pendingStreamStartTime, runtimeStatus, lastAbortReason)
    .isEligibleForAutoRetry;
}
