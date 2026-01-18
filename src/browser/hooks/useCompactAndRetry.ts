import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { buildSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceState } from "@/browser/stores/WorkspaceStore";
import {
  buildCompactionEditText,
  formatCompactionCommandLine,
} from "@/browser/utils/compaction/format";
import {
  getExplicitCompactionSuggestion,
  getHigherContextCompactionSuggestion,
  type CompactionSuggestion,
} from "@/browser/utils/compaction/suggestion";
import { executeCompaction } from "@/browser/utils/chatCommands";
import { CUSTOM_EVENTS, createCustomEvent, type CustomEventType } from "@/common/constants/events";
import { PREFERRED_COMPACTION_MODEL_KEY } from "@/common/constants/storage";
import type { ImagePart, ProvidersConfigMap } from "@/common/orpc/types";
import { buildContinueMessage, type DisplayedMessage } from "@/common/types/message";

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

export function useCompactAndRetry(props: { workspaceId: string }): CompactAndRetryState {
  const workspaceState = useWorkspaceState(props.workspaceId);
  const { api } = useAPI();
  const [providersConfig, setProvidersConfig] = useState<ProvidersConfigMap | null>(null);
  const [isRetryingWithCompaction, setIsRetryingWithCompaction] = useState(false);
  const isMountedRef = useRef(true);

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

  const retryWithCompaction = useCallback(async (): Promise<void> => {
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
      const sendMessageOptions = buildSendMessageOptions(props.workspaceId);
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
          workspaceId: props.workspaceId,
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
        workspaceId: props.workspaceId,
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
  }, [api, compactionSuggestion, props.workspaceId, triggerUserMessage]);

  useEffect(() => {
    if (!showCompactionUI) return;

    const handleCompactRetryRequested = (event: Event) => {
      const customEvent = event as CustomEventType<
        typeof CUSTOM_EVENTS.COMPACT_AND_RETRY_REQUESTED
      >;
      if (customEvent.detail.workspaceId !== props.workspaceId) return;
      if (isRetryingWithCompaction) return;
      retryWithCompaction().catch(() => undefined);
    };

    window.addEventListener(CUSTOM_EVENTS.COMPACT_AND_RETRY_REQUESTED, handleCompactRetryRequested);

    return () => {
      window.removeEventListener(
        CUSTOM_EVENTS.COMPACT_AND_RETRY_REQUESTED,
        handleCompactRetryRequested
      );
    };
  }, [isRetryingWithCompaction, props.workspaceId, retryWithCompaction, showCompactionUI]);

  return {
    showCompactionUI,
    compactionSuggestion,
    isRetryingWithCompaction,
    hasTriggerUserMessage: !!triggerUserMessage,
    hasCompactionRequest: !!triggerUserMessage?.compactionRequest,
    retryWithCompaction,
  };
}
