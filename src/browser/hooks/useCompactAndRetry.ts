import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceState } from "@/browser/stores/WorkspaceStore";
import {
  formatCompactionCommandLine,
  getFollowUpContentText,
} from "@/browser/utils/compaction/format";
import {
  getExplicitCompactionSuggestion,
  getHigherContextCompactionSuggestion,
  type CompactionSuggestion,
} from "@/browser/utils/compaction/suggestion";
import { executeCompaction } from "@/browser/utils/chatCommands";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { PREFERRED_COMPACTION_MODEL_KEY } from "@/common/constants/storage";
import type { FilePart, ProvidersConfigMap } from "@/common/orpc/types";
import {
  buildAgentSkillMetadata,
  type CompactionFollowUpInput,
  type DisplayedMessage,
} from "@/common/types/message";

interface CompactAndRetryState {
  showCompactionUI: boolean;
  compactionSuggestion: CompactionSuggestion | null;
  isRetryingWithCompaction: boolean;
  hasTriggerUserMessage: boolean;
  hasCompactionRequest: boolean;
  retryWithCompaction: () => Promise<void>;
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

/**
 * Build follow-up content from a user message source.
 * Preserves skill metadata if the original message was a skill invocation.
 */
function buildFollowUpFromSource(
  source: Extract<DisplayedMessage, { type: "user" }>
): CompactionFollowUpInput {
  return {
    text: source.content,
    fileParts: source.fileParts,
    reviews: source.reviews,
    muxMetadata: source.agentSkill
      ? buildAgentSkillMetadata({
          rawCommand: source.content,
          skillName: source.agentSkill.skillName,
          scope: source.agentSkill.scope,
        })
      : undefined,
  };
}

export function useCompactAndRetry(props: { workspaceId: string }): CompactAndRetryState {
  const workspaceState = useWorkspaceState(props.workspaceId);
  const { api } = useAPI();
  const policyState = usePolicy();
  const effectivePolicy =
    policyState.status.state === "enforced" ? (policyState.policy ?? null) : null;
  const [providersConfig, setProvidersConfig] = useState<ProvidersConfigMap | null>(null);
  const [isRetryingWithCompaction, setIsRetryingWithCompaction] = useState(false);
  const isMountedRef = useRef(true);
  const autoCompactionAttemptRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const lastMessage = workspaceState
    ? workspaceState.messages[workspaceState.messages.length - 1]
    : undefined;

  const triggerUserMessage = useMemo(() => {
    if (!workspaceState) return null;
    return findTriggerUserMessage(workspaceState.messages);
  }, [workspaceState]);

  const isCompactionRecoveryFlow =
    lastMessage?.type === "stream-error" && !!triggerUserMessage?.compactionRequest;

  const isContextExceeded =
    lastMessage?.type === "stream-error" && lastMessage.errorType === "context_exceeded";

  const showCompactionUI = isContextExceeded || isCompactionRecoveryFlow;

  const [preferredCompactionModel] = usePersistedState<string>(PREFERRED_COMPACTION_MODEL_KEY, "", {
    listener: true,
  });

  useEffect(() => {
    if (!api) return;
    if (!showCompactionUI) return;
    if (providersConfig) return;

    let active = true;
    const fetchProvidersConfig = async () => {
      try {
        const cfg = await api.providers.getConfig();
        if (active) {
          setProvidersConfig(cfg);
        }
      } catch {
        // Ignore failures fetching config (we just won't show a suggestion).
      }
    };

    fetchProvidersConfig().catch(() => undefined);

    return () => {
      active = false;
    };
  }, [api, showCompactionUI, providersConfig]);

  const compactionTargetModel = useMemo(() => {
    if (!showCompactionUI) return null;
    if (triggerUserMessage?.compactionRequest?.parsed.model) {
      return triggerUserMessage.compactionRequest.parsed.model;
    }
    if (lastMessage?.type === "stream-error") {
      return lastMessage.model ?? workspaceState?.currentModel ?? null;
    }
    return workspaceState?.currentModel ?? null;
  }, [showCompactionUI, triggerUserMessage, lastMessage, workspaceState?.currentModel]);

  const compactionSuggestion = useMemo<CompactionSuggestion | null>(() => {
    if (!showCompactionUI || !compactionTargetModel) {
      return null;
    }

    if (isCompactionRecoveryFlow) {
      return getHigherContextCompactionSuggestion({
        currentModel: compactionTargetModel,
        providersConfig,
        policy: effectivePolicy,
      });
    }

    const preferred = preferredCompactionModel.trim();
    if (preferred.length > 0) {
      const explicit = getExplicitCompactionSuggestion({
        modelId: preferred,
        providersConfig,
        policy: effectivePolicy,
      });
      if (explicit) {
        return explicit;
      }
    }

    return getHigherContextCompactionSuggestion({
      currentModel: compactionTargetModel,
      providersConfig,
      policy: effectivePolicy,
    });
  }, [
    compactionTargetModel,
    showCompactionUI,
    isCompactionRecoveryFlow,
    providersConfig,
    effectivePolicy,
    preferredCompactionModel,
  ]);

  /**
   * Manual retry: user clicked "Compact & retry" button.
   * On failure, falls back to inserting the command into chat input.
   */
  const retryWithCompaction = useCallback(async (): Promise<void> => {
    const insertIntoChatInput = (text: string, fileParts?: FilePart[]): void => {
      window.dispatchEvent(
        createCustomEvent(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, {
          text,
          mode: "replace",
          fileParts,
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
      const sendMessageOptions = getSendOptionsFromStorage(props.workspaceId);
      const source = triggerUserMessage;

      if (!source) {
        insertIntoChatInput(suggestedCommandLine + "\n");
        return;
      }

      // For compaction recovery (retrying a failed /compact), preserve the original settings.
      // The nested follow-up content is already in the correct format.
      if (source.compactionRequest) {
        const parsedCompaction = source.compactionRequest.parsed;
        const maxOutputTokens = parsedCompaction.maxOutputTokens;
        const nestedFollowUp = parsedCompaction.followUpContent;
        const result = await executeCompaction({
          api,
          workspaceId: props.workspaceId,
          sendMessageOptions,
          model: compactionSuggestion.modelId,
          maxOutputTokens,
          followUpContent: nestedFollowUp,
          editMessageId: source.id,
        });

        if (!result.success) {
          console.error("Failed to retry compaction:", result.error);

          const slashCommand = formatCompactionCommandLine({
            model: compactionSuggestion.modelArg,
            maxOutputTokens,
          });

          const continueText = getFollowUpContentText(nestedFollowUp);
          const fallbackText = continueText ? `${slashCommand}\n${continueText}` : slashCommand;
          const shouldAppendNewline = !continueText;

          insertIntoChatInput(
            fallbackText + (shouldAppendNewline ? "\n" : ""),
            nestedFollowUp?.fileParts
          );
        }

        return;
      }

      // For normal messages (not /compact), build follow-up content directly.
      const followUpContent = buildFollowUpFromSource(source);
      const result = await executeCompaction({
        api,
        workspaceId: props.workspaceId,
        sendMessageOptions,
        model: compactionSuggestion.modelId,
        followUpContent,
        editMessageId: source.id,
      });

      if (!result.success) {
        console.error("Failed to start compaction:", result.error);
        insertIntoChatInput(suggestedCommandLine + "\n" + source.content, source.fileParts);
      }
    } catch (error) {
      console.error("Failed to retry with compaction:", error);
      insertIntoChatInput(suggestedCommandLine + "\n");
    } finally {
      if (isMountedRef.current) {
        setIsRetryingWithCompaction(false);
      }
    }
  }, [api, compactionSuggestion, props.workspaceId, triggerUserMessage]);

  /**
   * Auto-compact on context_exceeded. Runs silently - never touches chat input.
   * Returns true if compaction was attempted, false if preconditions not met.
   */
  const autoCompact = useCallback(async (): Promise<boolean> => {
    if (!api || !triggerUserMessage || triggerUserMessage.compactionRequest) {
      return false;
    }

    if (isMountedRef.current) {
      setIsRetryingWithCompaction(true);
    }

    try {
      const sendMessageOptions = getSendOptionsFromStorage(props.workspaceId);
      const followUpContent = buildFollowUpFromSource(triggerUserMessage);

      const result = await executeCompaction({
        api,
        workspaceId: props.workspaceId,
        sendMessageOptions,
        model: compactionSuggestion?.modelId,
        followUpContent,
        editMessageId: triggerUserMessage.id,
      });

      if (!result.success) {
        console.error("Auto-compaction failed:", result.error);
      }
      return result.success;
    } catch (error) {
      console.error("Auto-compaction error:", error);
      return false;
    } finally {
      if (isMountedRef.current) {
        setIsRetryingWithCompaction(false);
      }
    }
  }, [api, compactionSuggestion?.modelId, props.workspaceId, triggerUserMessage]);

  // Auto-trigger compaction on context_exceeded for seamless recovery.
  // Only auto-compact if we have a compaction suggestion; otherwise show manual UI.
  const shouldAutoCompact =
    api &&
    isContextExceeded &&
    providersConfig !== undefined &&
    compactionSuggestion &&
    triggerUserMessage &&
    !triggerUserMessage.compactionRequest &&
    lastMessage?.type === "stream-error" &&
    !isRetryingWithCompaction;

  useEffect(() => {
    if (!shouldAutoCompact || !lastMessage) return;
    if (autoCompactionAttemptRef.current === lastMessage.id) return;

    autoCompactionAttemptRef.current = lastMessage.id;
    autoCompact().catch(() => undefined);
  }, [shouldAutoCompact, lastMessage, autoCompact]);

  return {
    showCompactionUI,
    compactionSuggestion,
    isRetryingWithCompaction,
    hasTriggerUserMessage: !!triggerUserMessage,
    hasCompactionRequest: !!triggerUserMessage?.compactionRequest,
    retryWithCompaction,
  };
}
