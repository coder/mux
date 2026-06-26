import { useCallback, useEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceState } from "@/browser/stores/WorkspaceStore";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { applyCompactionOverrides } from "@/browser/utils/messages/compactionOptions";
import { formatSendMessageError } from "@/common/utils/errors/formatSendError";
import { getErrorMessage } from "@/common/utils/errors";

export interface UseResumeStreamResult {
  /** Resume/continue the interrupted (or failed) stream from where it stopped. */
  resume: () => Promise<void>;
  /** True while a resume request is in flight; guards against double-trigger. */
  isResuming: boolean;
  /** Last resume error, if any. */
  error: string | null;
  /** Clear the current error. */
  clearError: () => void;
}

export interface UseResumeStreamOptions {
  /**
   * When true (default), the resumed attempt temporarily enables auto-retry
   * (persist:false) so transient failures keep retrying, then restores the
   * user's preference once the attempt reaches a terminal outcome. This is the
   * RetryBarrier semantic (it stays mounted across the whole lifecycle).
   *
   * Set false for callers that may unmount mid-attempt (e.g. the interrupted
   * divider, which ChatPane hides once auto-retry becomes active): a user
   * pressing Esc asked to stop, so "continue once" is the correct semantic, and
   * skipping the enable+rollback avoids canceling an in-flight scheduled retry
   * on unmount. Auto-retry-enabled users still get backend recovery because the
   * backend consults the persisted preference on failure regardless.
   */
  autoRetryOnFailure?: boolean;

  /**
   * Extra identity for the transient UI state (error/isResuming) beyond
   * workspaceId. When this changes, the hook resets that state so a stale error
   * can't appear against a different target. The divider passes the resume
   * target message id, so a failed continue on one interrupted turn never bleeds
   * onto a later interrupted turn in the same workspace.
   */
  resetKey?: string | null;
}

/**
 * Shared "continue from where it stopped" flow used by both the RetryBarrier
 * button (system/error interrupts) and the InterruptedBarrier splitter
 * (user-initiated interrupts via Esc).
 *
 * Both entry points must behave identically to the backend auto-retry path:
 * resumeStream does no history shaping, so the model simply continues the
 * partial assistant turn (plus an ephemeral [CONTINUE] sentinel injected at
 * transform time). The only client-side responsibility is temporarily enabling
 * auto-retry for the resumed attempt without silently flipping the user's
 * persisted preference.
 */
export function useResumeStream(
  workspaceId: string,
  options?: UseResumeStreamOptions
): UseResumeStreamResult {
  const autoRetryOnFailure = options?.autoRetryOnFailure ?? true;
  const { api } = useAPI();
  const workspaceState = useWorkspaceState(workspaceId);
  const [error, setError] = useState<string | null>(null);
  const [isResuming, setIsResuming] = useState(false);

  // ChatPane owns this hook and stays mounted across workspace switches (and
  // across changing resume targets), so transient UI state (error, isResuming)
  // must not bleed across either. Identity = workspaceId + optional resetKey.
  // Reset during render when identity changes (React's "adjust state during
  // render" pattern — no effect needed), and track the latest identity so a
  // resume that resolves after a switch/target change can't write onto it.
  const identity = `${workspaceId}\u0000${options?.resetKey ?? ""}`;
  const latestIdentityRef = useRef(identity);
  latestIdentityRef.current = identity;
  const [trackedIdentity, setTrackedIdentity] = useState(identity);
  if (identity !== trackedIdentity) {
    setTrackedIdentity(identity);
    setError(null);
    setIsResuming(false);
  }

  const autoRetryStatus = workspaceState.autoRetryStatus;

  // Manual resume temporarily enables auto-retry (persist:false) so the resumed
  // attempt is retried on transient failure, then restores the user's preference
  // once the attempt reaches a terminal outcome. These refs drive that rollback.
  const rollbackWorkspaceIdRef = useRef<string | null>(null);
  const rollbackPendingRef = useRef(false);
  const rollbackArmedRef = useRef(false);
  const rollbackBaselineMessageCountRef = useRef<number | null>(null);
  const apiRef = useRef(api);

  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  const rollbackAutoRetryIfNeeded = useCallback(
    async (options?: { suppressErrors?: boolean }): Promise<void> => {
      if (!rollbackPendingRef.current) {
        return;
      }

      const rollbackWorkspaceId = rollbackWorkspaceIdRef.current;
      rollbackPendingRef.current = false;
      rollbackArmedRef.current = false;
      rollbackBaselineMessageCountRef.current = null;
      rollbackWorkspaceIdRef.current = null;

      const activeApi = apiRef.current;
      if (!activeApi || !rollbackWorkspaceId) {
        return;
      }

      const rollbackResult = await activeApi.workspace.setAutoRetryEnabled?.({
        workspaceId: rollbackWorkspaceId,
        enabled: false,
        persist: false,
      });
      if (rollbackResult && !rollbackResult.success && !options?.suppressErrors) {
        setError(rollbackResult.error);
      }
    },
    []
  );

  // Workspace switched while a rollback was pending: restore in the previous workspace.
  useEffect(() => {
    if (!rollbackPendingRef.current) {
      return;
    }

    const rollbackWorkspaceId = rollbackWorkspaceIdRef.current;
    if (!rollbackWorkspaceId || rollbackWorkspaceId === workspaceId) {
      return;
    }

    void rollbackAutoRetryIfNeeded();
  }, [workspaceId, rollbackAutoRetryIfNeeded]);

  // Unmount: restore preference best-effort.
  useEffect(() => {
    return () => {
      if (!rollbackPendingRef.current) {
        return;
      }

      void rollbackAutoRetryIfNeeded({ suppressErrors: true });
    };
  }, [rollbackAutoRetryIfNeeded]);

  useEffect(() => {
    if (!rollbackPendingRef.current) {
      return;
    }

    const autoRetryActive =
      autoRetryStatus?.type === "auto-retry-scheduled" ||
      autoRetryStatus?.type === "auto-retry-starting";
    const streamInFlight = workspaceState.isStreamStarting || workspaceState.canInterrupt;

    // Mirror ask_user rollback semantics: keep temporary enablement while the resumed
    // stream/retry attempt is in flight, then restore preference after terminal outcome.
    if (autoRetryActive || streamInFlight) {
      rollbackArmedRef.current = true;
      return;
    }

    const baselineMessageCount = rollbackBaselineMessageCountRef.current;
    const hasObservedPostRetryMessage =
      baselineMessageCount !== null && workspaceState.messages.length > baselineMessageCount;
    if (!rollbackArmedRef.current && !hasObservedPostRetryMessage) {
      return;
    }

    void rollbackAutoRetryIfNeeded();
  }, [
    autoRetryStatus,
    workspaceState.isStreamStarting,
    workspaceState.canInterrupt,
    workspaceState.messages.length,
    rollbackAutoRetryIfNeeded,
  ]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const resume = async (): Promise<void> => {
    if (!api) {
      setError("Not connected to server");
      return;
    }

    if (isResuming) {
      return;
    }

    const startedForIdentity = identity;
    // Drop state updates if the workspace or resume target changed before this
    // resolved, so a stale resume can't surface its error/spinner on a different
    // workspace or interrupted turn.
    const applyIfCurrent = (apply: () => void): void => {
      if (latestIdentityRef.current === startedForIdentity) apply();
    };

    setIsResuming(true);
    setError(null);

    try {
      let options = getSendOptionsFromStorage(workspaceId);
      const lastUserMessage = [...workspaceState.messages]
        .reverse()
        .find(
          (message): message is Extract<typeof message, { type: "user" }> => message.type === "user"
        );

      if (lastUserMessage?.compactionRequest) {
        options = applyCompactionOverrides(options, lastUserMessage.compactionRequest.parsed);
      }

      if (autoRetryOnFailure) {
        const enableResult = await api.workspace.setAutoRetryEnabled?.({
          workspaceId,
          enabled: true,
          persist: false,
        });
        if (enableResult && !enableResult.success) {
          applyIfCurrent(() => setError(enableResult.error));
          return;
        }

        if (enableResult?.success && enableResult.data.previousEnabled === false) {
          // Manual resume temporarily enables auto-retry for this resumed attempt.
          // Restore only when stream/retry outcome is terminal.
          rollbackWorkspaceIdRef.current = workspaceId;
          rollbackPendingRef.current = true;
          rollbackArmedRef.current = false;
          rollbackBaselineMessageCountRef.current = workspaceState.messages.length;
        }
      }

      const resumeResult = await api.workspace.resumeStream({
        workspaceId,
        options,
      });

      if (!resumeResult.success) {
        const formatted = formatSendMessageError(resumeResult.error);
        const details = formatted.resolutionHint
          ? `${formatted.message} ${formatted.resolutionHint}`
          : formatted.message;
        applyIfCurrent(() => setError(details));

        // Keep preference consistent when resume fails before retry/stream events.
        await rollbackAutoRetryIfNeeded();
        return;
      }

      if (
        rollbackPendingRef.current &&
        !rollbackArmedRef.current &&
        resumeResult.data.started === false
      ) {
        await rollbackAutoRetryIfNeeded();
      }
    } catch (err) {
      applyIfCurrent(() => setError(getErrorMessage(err)));
      await rollbackAutoRetryIfNeeded();
    } finally {
      applyIfCurrent(() => setIsResuming(false));
    }
  };

  return { resume, isResuming, error, clearError };
}
