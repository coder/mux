import { useEffect, useRef } from "react";
import { useWorkspaceStoreRaw, type WorkspaceState } from "@/browser/stores/WorkspaceStore";
import { CUSTOM_EVENTS, type CustomEventType } from "@/common/constants/events";
import { getRetryStateKey } from "@/common/constants/storage";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { readPersistedState, updatePersistedState } from "./usePersistedState";
import { readAutoRetryPreference } from "@/browser/utils/messages/autoRetryPreference";
import {
  getInterruptionContext,
  isNonRetryableSendError,
} from "@/browser/utils/messages/retryEligibility";
import { applyCompactionOverrides } from "@/browser/utils/messages/compactionOptions";
import type { SendMessageError } from "@/common/types/errors";
import type { CompactionFollowUpRequest } from "@/common/types/message";
import {
  createFailedRetryState,
  calculateBackoffDelay,
  INITIAL_DELAY,
} from "@/browser/utils/messages/retryState";
import { useAPI } from "@/browser/contexts/API";

export interface RetryState {
  attempt: number;
  retryStartTime: number;
  lastError?: SendMessageError;
}

/**
 * Centralized auto-resume manager for interrupted streams
 *
 * DESIGN PRINCIPLE: Single Source of Truth for ALL Retry Logic
 * ============================================================
 * This hook is the ONLY place that calls api?.workspace.resumeStream().
 * All other components (RetryBarrier, etc.) emit RESUME_CHECK_REQUESTED events
 * and let this hook handle the actual retry logic.
 *
 * Why this matters:
 * - Consistency: All retries use the same backoff, state management, eligibility checks
 * - Maintainability: One place to update retry logic
 * - Background operation: Works for all workspaces, even non-visible ones
 * - Idempotency: Safe to emit events multiple times, hook silently ignores invalid requests
 *
 * autoRetry State Semantics (Explicit Transitions Only):
 * -------------------------------------------------------
 * - true (default): System errors should auto-retry with exponential backoff
 * - false: User pressed Ctrl+C - don't auto-retry until user re-engages
 *
 * State transitions:
 * - User presses Ctrl+C → autoRetry = false
 * - User sends a message → autoRetry = true (clear intent: "I'm using this")
 * - User clicks manual retry → autoRetry = true
 * - NO automatic resets on stream events (prevents initialization bugs)
 *
 * Features:
 * - Polling-based: Checks all workspaces every 1 second
 * - Event-driven: Also reacts to RESUME_CHECK_REQUESTED events for fast path
 * - Idempotent: Safe to call multiple times, silently ignores invalid requests
 * - Background operation: Works for all workspaces, visible or not
 * - Exponential backoff: 1s → 2s → 4s → 8s → ... → 60s (max)
 *
 * Checks happen on:
 * - App startup (initial scan)
 * - Every 1 second (polling)
 * - Stream errors/aborts (events for fast response)
 * - Manual retry button (event from RetryBarrier)
 */
export function useResumeManager() {
  const { api } = useAPI();
  // Get workspace states from store
  // NOTE: We use a ref-based approach instead of useSyncExternalStore to avoid
  // re-rendering AppInner on every workspace state change. This hook only needs
  // to check eligibility periodically (polling) and on events.
  const store = useWorkspaceStoreRaw();
  const workspaceStatesRef = useRef<Map<string, WorkspaceState>>(new Map());

  useEffect(() => {
    // Update ref whenever store changes (but don't trigger re-render)
    const updateStatesRef = () => {
      workspaceStatesRef.current = store.getAllStates();
    };

    // Initial load
    updateStatesRef();

    // Subscribe to keep ref fresh, but don't cause re-renders
    const unsubscribe = store.subscribe(() => {
      updateStatesRef();
    });

    return unsubscribe;
  }, [store]);

  // Track which workspaces are currently retrying (prevent concurrent retries)
  const retryingRef = useRef<Set<string>>(new Set());

  /**
   * Check if a workspace is eligible for auto-resume
   * Idempotent - returns false if conditions aren't met
   */
  const isEligibleForResume = (workspaceId: string): boolean => {
    const state = workspaceStatesRef.current.get(workspaceId);
    if (!state) {
      return false;
    }

    // 1. Must have interrupted stream that's eligible for auto-retry (not currently streaming)
    if (state.canInterrupt) return false; // Currently streaming

    const { isEligibleForAutoRetry } = getInterruptionContext(
      state.messages,
      state.pendingStreamStartTime,
      state.runtimeStatus,
      state.lastAbortReason
    );
    if (!isEligibleForAutoRetry) {
      return false;
    }

    // 2. Auto-retry must be enabled (user didn't press Ctrl+C)
    const autoRetry = readAutoRetryPreference(workspaceId);
    if (!autoRetry) return false;

    // 3. Must not already be retrying
    if (retryingRef.current.has(workspaceId)) return false;

    // 4. Check if previous error was non-retryable (e.g., api_key_not_found)
    const retryState = readPersistedState<RetryState>(
      getRetryStateKey(workspaceId),
      { attempt: 0, retryStartTime: Date.now() - INITIAL_DELAY } // Make immediately eligible on first check
    );

    if (retryState.lastError && isNonRetryableSendError(retryState.lastError)) {
      // Don't auto-retry errors that require user action
      // Manual retry is still available via RetryBarrier
      return false;
    }

    // 5. Check exponential backoff timer
    const { attempt, retryStartTime } = retryState;
    const delay = calculateBackoffDelay(attempt);
    const timeSinceLastRetry = Date.now() - retryStartTime;

    if (timeSinceLastRetry < delay) return false; // Not time yet

    return true;
  };

  /**
   * Attempt to resume a workspace stream
   * Polling will check eligibility every 1 second
   *
   * @param workspaceId - The workspace to resume
   * @param isManual - If true, bypass eligibility checks (user explicitly clicked retry)
   */
  const attemptResume = async (workspaceId: string, isManual = false) => {
    if (isManual) {
      store.clearLastAbortReason(workspaceId);
    }

    // Skip eligibility checks for manual retries (user explicitly wants to retry)
    if (!isManual && !isEligibleForResume(workspaceId)) return;

    // Mark as retrying
    retryingRef.current.add(workspaceId);

    // Read current retry state
    const retryState = readPersistedState<RetryState>(getRetryStateKey(workspaceId), {
      attempt: 0,
      retryStartTime: Date.now(),
    });

    const { attempt } = retryState;
    console.debug(
      `[retry] ${workspaceId} attemptResume: current attempt=${attempt}, isManual=${isManual}`
    );

    try {
      // Start with workspace defaults
      let options = getSendOptionsFromStorage(workspaceId);

      // Check if last user message was a compaction request
      const state = workspaceStatesRef.current.get(workspaceId);
      if (state) {
        const lastUserMsg = [...state.messages].reverse().find((msg) => msg.type === "user");
        if (lastUserMsg?.compactionRequest) {
          // Apply compaction overrides using shared function (same as ChatInput)
          // This ensures custom model/tokens are preserved across resume
          // Support both new `followUpContent` and legacy `continueMessage` for backwards compatibility
          const parsedCompaction = lastUserMsg.compactionRequest.parsed as {
            model?: string;
            maxOutputTokens?: number;
            followUpContent?: CompactionFollowUpRequest;
            continueMessage?: CompactionFollowUpRequest;
          };
          options = applyCompactionOverrides(options, {
            model: parsedCompaction.model,
            maxOutputTokens: parsedCompaction.maxOutputTokens,
            followUpContent: parsedCompaction.followUpContent ?? parsedCompaction.continueMessage,
          });
        }
      }

      if (!api) {
        retryingRef.current.delete(workspaceId);
        return;
      }
      const result = await api.workspace.resumeStream({ workspaceId, options });

      if (!result.success) {
        // Store error in retry state so RetryBarrier can display it
        const newState = createFailedRetryState(attempt, result.error);
        console.debug(
          `[retry] ${workspaceId} resumeStream failed: attempt ${attempt} → ${newState.attempt}`
        );
        updatePersistedState(getRetryStateKey(workspaceId), newState);
      }
      // Note: Don't clear retry state on success - stream-end event will handle that
      // resumeStream success just means "stream initiated", not "stream completed"
      // Clearing here causes backoff reset bug when stream starts then immediately fails
    } catch (error) {
      // Store error in retry state for display
      const errorData: SendMessageError = {
        type: "unknown",
        raw: error instanceof Error ? error.message : "Failed to resume stream",
      };
      const newState = createFailedRetryState(attempt, errorData);
      console.debug(
        `[retry] ${workspaceId} resumeStream exception: attempt ${attempt} → ${newState.attempt}`
      );
      updatePersistedState(getRetryStateKey(workspaceId), newState);
    } finally {
      // Always clear retrying flag
      retryingRef.current.delete(workspaceId);
    }
  };

  useEffect(() => {
    // Initial scan on mount - check all workspaces for interrupted streams
    for (const [workspaceId] of workspaceStatesRef.current) {
      void attemptResume(workspaceId);
    }

    // Listen for resume check requests (primary mechanism)
    const handleResumeCheck = (event: Event) => {
      const customEvent = event as CustomEventType<typeof CUSTOM_EVENTS.RESUME_CHECK_REQUESTED>;
      const { workspaceId, isManual = false } = customEvent.detail;
      void attemptResume(workspaceId, isManual);
    };

    window.addEventListener(CUSTOM_EVENTS.RESUME_CHECK_REQUESTED, handleResumeCheck);

    // Backup polling mechanism - check all workspaces every 1 second
    // This is defense-in-depth in case events are missed
    const pollInterval = setInterval(() => {
      for (const [workspaceId] of workspaceStatesRef.current) {
        void attemptResume(workspaceId);
      }
    }, 1000);

    return () => {
      window.removeEventListener(CUSTOM_EVENTS.RESUME_CHECK_REQUESTED, handleResumeCheck);
      clearInterval(pollInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Stable effect - no deps, uses refs
}
