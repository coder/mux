import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { buildSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import { usePersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { RetryState } from "@/browser/hooks/useResumeManager";
import { useWorkspaceState } from "@/browser/stores/WorkspaceStore";
import {
  getExplicitCompactionSuggestion,
  getHigherContextCompactionSuggestion,
  type CompactionSuggestion,
} from "@/browser/utils/compaction/suggestion";
import {
  buildCompactionEditText,
  formatCompactionCommandLine,
} from "@/browser/utils/compaction/format";
import { executeCompaction } from "@/browser/utils/chatCommands";
import {
  isEligibleForAutoRetry,
  isNonRetryableSendError,
} from "@/browser/utils/messages/retryEligibility";
import { calculateBackoffDelay, createManualRetryState } from "@/browser/utils/messages/retryState";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import {
  getAutoRetryKey,
  getRetryStateKey,
  PREFERRED_COMPACTION_MODEL_KEY,
  VIM_ENABLED_KEY,
} from "@/common/constants/storage";
import { cn } from "@/common/lib/utils";
import type { ImagePart, ProvidersConfigMap } from "@/common/orpc/types";
import { buildContinueMessage, type DisplayedMessage } from "@/common/types/message";
import { formatSendMessageError } from "@/common/utils/errors/formatSendError";
import { formatTokens } from "@/common/utils/tokens/tokenMeterUtils";

interface RetryBarrierProps {
  workspaceId: string;
  className?: string;
}

function formatContextTokens(tokens: number): string {
  return formatTokens(tokens).replace(/\.0([kM])$/, "$1");
}

function findTriggerUserMessage(
  messages: DisplayedMessage[]
): Extract<DisplayedMessage, { type: "user" }> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === "user") {
      return msg;
    }
  }

  return null;
}
const defaultRetryState: RetryState = {
  attempt: 0,
  retryStartTime: Date.now(),
};

export const RetryBarrier: React.FC<RetryBarrierProps> = ({ workspaceId, className }) => {
  // Get workspace state for computing effective autoRetry
  const workspaceState = useWorkspaceState(workspaceId);

  const { api } = useAPI();
  const [isRetryingWithCompaction, setIsRetryingWithCompaction] = useState(false);
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const [providersConfig, setProvidersConfig] = useState<ProvidersConfigMap | null>(null);

  const lastMessage = workspaceState
    ? workspaceState.messages[workspaceState.messages.length - 1]
    : undefined;

  const isContextExceeded =
    lastMessage?.type === "stream-error" && lastMessage.errorType === "context_exceeded";

  // Check if we're in a compaction recovery flow: the last user message was a compaction request
  // that failed. This persists the compaction UI even if the retry fails with a different error.
  const triggerUserMessage = useMemo(() => {
    if (!workspaceState) return null;
    return findTriggerUserMessage(workspaceState.messages);
  }, [workspaceState]);

  const isCompactionRecoveryFlow =
    lastMessage?.type === "stream-error" && !!triggerUserMessage?.compactionRequest;

  // Show compaction UI if either: original context_exceeded OR we're retrying a failed compaction
  const showCompactionUI = isContextExceeded || isCompactionRecoveryFlow;

  // This is a rare error state; we only need a snapshot of provider config to make a
  // best-effort suggestion (no subscriptions / real-time updates required).
  useEffect(() => {
    if (!api) return;
    if (!showCompactionUI) return;
    if (providersConfig) return;

    let active = true;
    void (async () => {
      try {
        const cfg = await api.providers.getConfig();
        if (active) {
          setProvidersConfig(cfg);
        }
      } catch {
        // Ignore failures fetching config (we just won't show a suggestion).
      }
    })();

    return () => {
      active = false;
    };
  }, [api, showCompactionUI, providersConfig]);

  // For compaction recovery, use the model from the original compaction request or fall back to workspace model
  const compactionTargetModel = useMemo(() => {
    if (!showCompactionUI) return null;
    // If retrying a failed compaction, use the model from that request
    if (triggerUserMessage?.compactionRequest?.parsed.model) {
      return triggerUserMessage.compactionRequest.parsed.model;
    }
    // Otherwise use the model from the error or workspace
    if (lastMessage?.type === "stream-error") {
      return lastMessage.model ?? workspaceState?.currentModel ?? null;
    }
    return workspaceState?.currentModel ?? null;
  }, [showCompactionUI, triggerUserMessage, lastMessage, workspaceState?.currentModel]);

  // Read preferences from localStorage

  const [preferredCompactionModel] = usePersistedState<string>(
    PREFERRED_COMPACTION_MODEL_KEY,
    "", // Default to empty (use workspace model)
    { listener: true }
  );
  const [autoRetry, setAutoRetry] = usePersistedState<boolean>(
    getAutoRetryKey(workspaceId),
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
    getRetryStateKey(workspaceId),
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
      workspaceState.pendingStreamStartTime
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

  const compactionSuggestion = useMemo<CompactionSuggestion | null>(() => {
    // Opportunistic: only attempt suggestions when we can confidently identify the model.
    if (!showCompactionUI || !compactionTargetModel) {
      return null;
    }

    // If we're retrying a failed compaction request, prefer a larger-context model to recover.
    if (isCompactionRecoveryFlow) {
      return getHigherContextCompactionSuggestion({
        currentModel: compactionTargetModel,
        providersConfig,
      });
    }

    const preferred = preferredCompactionModel.trim();
    if (preferred.length > 0) {
      const explicit = getExplicitCompactionSuggestion({
        modelId: preferred,
        providersConfig,
      });
      if (explicit) {
        return explicit;
      }
    }

    return getHigherContextCompactionSuggestion({
      currentModel: compactionTargetModel,
      providersConfig,
    });
  }, [
    compactionTargetModel,
    showCompactionUI,
    isCompactionRecoveryFlow,
    providersConfig,
    preferredCompactionModel,
  ]);

  async function handleRetryWithCompaction(): Promise<void> {
    const insertIntoChatInput = (text: string, imageParts?: ImagePart[]): void => {
      window.dispatchEvent(
        createCustomEvent(CUSTOM_EVENTS.INSERT_TO_CHAT_INPUT, {
          text,
          mode: "replace",
          imageParts,
        })
      );
    };

    if (!compactionSuggestion) {
      insertIntoChatInput("/compact\n");
      return;
    }

    const suggestedCommandLine = formatCompactionCommandLine({
      model: compactionSuggestion.modelArg,
    });

    if (!api) {
      insertIntoChatInput(suggestedCommandLine + "\n");
      return;
    }

    if (isMountedRef.current) {
      setIsRetryingWithCompaction(true);
    }
    try {
      // Read fresh values at click-time (workspace might have switched models).
      const sendMessageOptions = buildSendMessageOptions(workspaceId);

      // Best-effort: fall back to the nearest user message if we can't find the exact one.
      const source = triggerUserMessage;

      if (!source) {
        insertIntoChatInput(suggestedCommandLine + "\n");
        return;
      }

      if (source.compactionRequest) {
        const maxOutputTokens = source.compactionRequest.parsed.maxOutputTokens;
        const continueMessage = source.compactionRequest.parsed.continueMessage;

        const result = await executeCompaction({
          api,
          workspaceId,
          sendMessageOptions,
          model: compactionSuggestion.modelId,
          maxOutputTokens,
          continueMessage,
        });

        if (!result.success) {
          console.error("Failed to retry compaction:", result.error);

          const rawCommand = formatCompactionCommandLine({
            model: compactionSuggestion.modelArg,
            maxOutputTokens,
          });

          const fallbackText = buildCompactionEditText({
            rawCommand,
            parsed: {
              model: compactionSuggestion.modelArg,
              maxOutputTokens,
              continueMessage,
            },
          });

          const shouldAppendNewline =
            !continueMessage?.text || continueMessage.text.trim().length === 0;

          insertIntoChatInput(
            fallbackText + (shouldAppendNewline ? "\n" : ""),
            continueMessage?.imageParts
          );
        }

        return;
      }

      const continueMessage = buildContinueMessage({
        text: source.content,
        imageParts: source.imageParts,
        reviews: source.reviews,
        model: sendMessageOptions.model,
        agentId: sendMessageOptions.agentId ?? "exec",
      });

      if (!continueMessage) {
        insertIntoChatInput(suggestedCommandLine + "\n");
        return;
      }

      const result = await executeCompaction({
        api,
        workspaceId,
        sendMessageOptions,
        model: compactionSuggestion.modelId,
        continueMessage,
      });

      if (!result.success) {
        console.error("Failed to start compaction:", result.error);
        insertIntoChatInput(suggestedCommandLine + "\n" + source.content, source.imageParts);
      }
    } catch (error) {
      console.error("Failed to retry with compaction", error);
      insertIntoChatInput(suggestedCommandLine + "\n");
    } finally {
      if (isMountedRef.current) {
        setIsRetryingWithCompaction(false);
      }
    }
  }

  // Manual retry handler (user-initiated, immediate)
  // Emits event to useResumeManager instead of calling resumeStream directly
  // This keeps all retry logic centralized in one place
  const handleManualRetry = () => {
    setAutoRetry(true); // Re-enable auto-retry for next failure

    // Create manual retry state: immediate retry BUT preserves attempt counter
    // This prevents infinite retry loops without backoff if the retry fails
    updatePersistedState(getRetryStateKey(workspaceId), createManualRetryState(attempt));

    // Emit event to useResumeManager - it will handle the actual resume
    // Pass isManual flag to bypass eligibility checks (user explicitly wants to retry)
    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.RESUME_CHECK_REQUESTED, {
        workspaceId,
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

  const details = showCompactionUI ? (
    <div className="font-primary text-foreground/80 pl-8 text-[12px]">
      <span className="text-warning font-semibold">Context window exceeded.</span>{" "}
      {compactionSuggestion ? (
        compactionSuggestion.kind === "preferred" ? (
          <>
            We&apos;ll compact with your configured compaction model{" "}
            <span className="text-foreground font-semibold">
              {compactionSuggestion.displayName}
            </span>
            {compactionSuggestion.maxInputTokens !== null ? (
              <> ({formatContextTokens(compactionSuggestion.maxInputTokens)} context)</>
            ) : null}{" "}
            to unblock you. Your workspace model stays the same.
          </>
        ) : (
          <>
            We&apos;ll compact with{" "}
            <span className="text-foreground font-semibold">
              {compactionSuggestion.displayName}
            </span>
            {compactionSuggestion.maxInputTokens !== null ? (
              <> ({formatContextTokens(compactionSuggestion.maxInputTokens)} context)</>
            ) : null}{" "}
            to unblock you with a higher-context model. Your workspace model stays the same.
          </>
        )
      ) : (
        <>Compact this chat to unblock you. Your workspace model stays the same.</>
      )}
    </div>
  ) : lastError ? (
    <div className="font-primary text-foreground/80 pl-8 text-[12px]">
      <span className="text-warning font-semibold">Error:</span> {getErrorMessage(lastError)}
    </div>
  ) : null;

  const barrierClassName = cn(
    "my-5 px-5 py-4 bg-gradient-to-br from-[rgba(255,165,0,0.1)] to-[rgba(255,140,0,0.1)] border-l-4 border-warning rounded flex flex-col gap-3",
    className
  );

  let statusIcon = "⚠️";
  let statusText: React.ReactNode = <>Stream interrupted</>;
  let actionButton: React.ReactNode;

  if (effectiveAutoRetry) {
    // Auto-retry mode: show countdown and stop button.
    // useResumeManager handles the actual retry logic.
    statusIcon = "🔄";
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
    const onClick = showCompactionUI ? () => void handleRetryWithCompaction() : handleManualRetry;

    let label = "Retry";
    if (showCompactionUI) {
      if (isRetryingWithCompaction) {
        label = "Starting...";
      } else if (!compactionSuggestion || !triggerUserMessage) {
        label = "Insert /compact";
      } else if (triggerUserMessage.compactionRequest) {
        label = "Retry compaction";
      } else {
        label = "Compact & retry";
      }
    }

    actionButton = (
      <button
        className="bg-warning font-primary text-background cursor-pointer rounded border-none px-4 py-2 text-xs font-semibold whitespace-nowrap transition-all duration-200 hover:-translate-y-px hover:brightness-120 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={onClick}
        disabled={showCompactionUI && isRetryingWithCompaction}
      >
        {label}
      </button>
    );
  }

  return (
    <div className={barrierClassName}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-1 items-center gap-3">
          <span className="text-lg leading-none">{statusIcon}</span>
          <div className="font-primary text-foreground text-[13px] font-medium">{statusText}</div>
        </div>
        {actionButton}
      </div>
      {details}
    </div>
  );
};
