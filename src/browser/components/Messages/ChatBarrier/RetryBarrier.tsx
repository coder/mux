import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { usePersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { RetryState } from "@/browser/hooks/useResumeManager";
import { useWorkspaceState } from "@/browser/stores/WorkspaceStore";
import {
  isEligibleForAutoRetry,
  isNonRetryableSendError,
} from "@/browser/utils/messages/retryEligibility";
import { calculateBackoffDelay, createManualRetryState } from "@/browser/utils/messages/retryState";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { getAutoRetryKey, getRetryStateKey, VIM_ENABLED_KEY } from "@/common/constants/storage";
import { cn } from "@/common/lib/utils";
import { formatSendMessageError } from "@/common/utils/errors/formatSendError";

interface RetryBarrierProps {
  workspaceId: string;
  className?: string;
}

const defaultRetryState: RetryState = {
  attempt: 0,
  retryStartTime: Date.now(),
};

export const RetryBarrier: React.FC<RetryBarrierProps> = (props) => {
  // Get workspace state for computing effective autoRetry
  const workspaceState = useWorkspaceState(props.workspaceId);

  const [autoRetry, setAutoRetry] = usePersistedState<boolean>(
    getAutoRetryKey(props.workspaceId),
    true, // Default to true
    { listener: true }
  );

  // Read vim mode for displaying correct stop keybind
  const [vimEnabled] = usePersistedState<boolean>(VIM_ENABLED_KEY, false, { listener: true });
  const stopKeybind = formatKeybind(
    vimEnabled ? KEYBINDS.INTERRUPT_STREAM_VIM : KEYBINDS.INTERRUPT_STREAM_NORMAL
  );

  // Use persisted state for retry tracking (survives workspace switches)
  // Read retry state (managed by useResumeManager)
  const [retryState] = usePersistedState<RetryState>(
    getRetryStateKey(props.workspaceId),
    defaultRetryState,
    { listener: true }
  );

  const { attempt, retryStartTime, lastError } = retryState || defaultRetryState;

  // Compute effective autoRetry state: user preference AND error is retryable
  // This ensures UI shows "Retry" button (not "Retrying...") for non-retryable errors
  const effectiveAutoRetry = useMemo(() => {
    if (!autoRetry || !workspaceState) {
      return false;
    }

    // Check if current state is eligible for auto-retry
    const messagesEligible = isEligibleForAutoRetry(
      workspaceState.messages,
      workspaceState.pendingStreamStartTime,
      workspaceState.runtimeStatus
    );

    // Also check RetryState for SendMessageErrors (from resumeStream failures)
    // Note: isNonRetryableSendError already respects window.__MUX_FORCE_ALL_RETRYABLE
    if (lastError && isNonRetryableSendError(lastError)) {
      return false; // Non-retryable SendMessageError
    }

    return messagesEligible;
  }, [autoRetry, workspaceState, lastError]);

  // Local state for UI
  const [countdown, setCountdown] = useState(0);

  // Update countdown display (pure display logic, no side effects)
  // useResumeManager handles the actual retry logic
  useEffect(() => {
    if (!autoRetry) return;

    const interval = setInterval(() => {
      const delay = calculateBackoffDelay(attempt);
      const nextRetryTime = retryStartTime + delay;
      const timeUntilRetry = Math.max(0, nextRetryTime - Date.now());

      setCountdown(Math.ceil(timeUntilRetry / 1000));
    }, 100);

    return () => clearInterval(interval);
  }, [autoRetry, attempt, retryStartTime]);

  // Manual retry handler (user-initiated, immediate)
  // Emits event to useResumeManager instead of calling resumeStream directly
  // This keeps all retry logic centralized in one place
  const handleManualRetry = () => {
    setAutoRetry(true); // Re-enable auto-retry for next failure

    // Create manual retry state: immediate retry BUT preserves attempt counter
    // This prevents infinite retry loops without backoff if the retry fails
    updatePersistedState(getRetryStateKey(props.workspaceId), createManualRetryState(attempt));

    // Emit event to useResumeManager - it will handle the actual resume
    // Pass isManual flag to bypass eligibility checks (user explicitly wants to retry)
    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.RESUME_CHECK_REQUESTED, {
        workspaceId: props.workspaceId,
        isManual: true,
      })
    );
  };

  // Stop auto-retry handler
  const handleStopAutoRetry = () => {
    setCountdown(0);
    setAutoRetry(false);
  };

  // Format error message for display (centralized logic)
  const getErrorMessage = (error: typeof lastError): string => {
    if (!error) return "";
    const formatted = formatSendMessageError(error);
    // Combine message with command if available
    return formatted.providerCommand
      ? `${formatted.message} Configure with ${formatted.providerCommand}`
      : formatted.message;
  };

  const details = lastError ? (
    <div className="font-primary text-foreground/80 pl-8 text-[12px]">
      <span className="text-warning font-semibold">Error:</span> {getErrorMessage(lastError)}
    </div>
  ) : null;

  const barrierClassName = cn(
    "my-5 px-5 py-4 bg-gradient-to-br from-[rgba(255,165,0,0.1)] to-[rgba(255,140,0,0.1)] border-l-4 border-warning rounded flex flex-col gap-3",
    props.className
  );

  let statusIcon: React.ReactNode = (
    <AlertTriangle aria-hidden="true" className="text-warning h-4 w-4 shrink-0" />
  );
  let statusText: React.ReactNode = <>Stream interrupted</>;
  let actionButton: React.ReactNode;

  if (effectiveAutoRetry) {
    // Auto-retry mode: show countdown and stop button.
    // useResumeManager handles the actual retry logic.
    statusIcon = (
      <RefreshCw aria-hidden="true" className="text-warning h-4 w-4 shrink-0 animate-spin" />
    );
    statusText =
      countdown === 0 ? (
        <>Retrying... (attempt {attempt + 1})</>
      ) : (
        <>
          Retrying in <span className="text-warning font-mono font-semibold">{countdown}s</span>{" "}
          (attempt {attempt + 1})
        </>
      );

    actionButton = (
      <button
        className="border-warning font-primary text-warning hover:bg-warning-overlay cursor-pointer rounded border bg-transparent px-4 py-2 text-xs font-semibold whitespace-nowrap transition-all duration-200 hover:-translate-y-px active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={handleStopAutoRetry}
      >
        Stop ({stopKeybind})
      </button>
    );
  } else {
    actionButton = (
      <button
        className="bg-warning font-primary text-background cursor-pointer rounded border-none px-4 py-2 text-xs font-semibold whitespace-nowrap transition-all duration-200 hover:-translate-y-px hover:brightness-120 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={handleManualRetry}
      >
        Retry
      </button>
    );
  }

  return (
    <div className={barrierClassName}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-1 items-center gap-3">
          <span className="shrink-0">{statusIcon}</span>
          <div className="font-primary text-foreground text-[13px] font-medium">{statusText}</div>
        </div>
        {actionButton}
      </div>
      {details}
    </div>
  );
};
