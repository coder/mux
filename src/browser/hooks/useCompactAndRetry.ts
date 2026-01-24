import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { buildSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceState } from "@/browser/stores/WorkspaceStore";
import {
  formatCompactionCommandLine,
  getCompactionContinueText,
} from "@/browser/utils/compaction/format";
import {
  getExplicitCompactionSuggestion,
  getHigherContextCompactionSuggestion,
  type CompactionSuggestion,
} from "@/browser/utils/compaction/suggestion";
import { executeCompaction } from "@/browser/utils/chatCommands";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { PREFERRED_COMPACTION_MODEL_KEY } from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import type { ImagePart, ProvidersConfigMap } from "@/common/orpc/types";
import {
  buildContinueMessage,
  type DisplayedMessage,
  type MuxFrontendMetadata,
} from "@/common/types/message";

interface CompactAndRetryState {
  showCompactionUI: boolean;
  compactionSuggestion: CompactionSuggestion | null;
  isRetryingWithCompaction: boolean;
  hasTriggerUserMessage: boolean;
  hasCompactionRequest: boolean;
  /** Manual retry - user clicked "Compact & retry" button. May update chat input on failure. */
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
  // undefined = not loaded yet, null = load attempted but empty/failed, value = loaded
  const [providersConfig, setProvidersConfig] = useState<ProvidersConfigMap | null | undefined>(
    undefined
  );
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
    if (providersConfig !== undefined) return; // Already loaded or failed

    let active = true;
    const fetchProvidersConfig = async () => {
      try {
        const cfg = await api.providers.getConfig();
        if (active) {
          setProvidersConfig(cfg);
        }
      } catch {
        // Mark as "loaded but empty" so dependents know fetch completed.
        if (active) {
          setProvidersConfig(null);
        }
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

    // Convert undefined to null for helper functions (undefined = loading, null = no config)
    const config = providersConfig ?? null;

    if (isCompactionRecoveryFlow) {
      return getHigherContextCompactionSuggestion({
        currentModel: compactionTargetModel,
        providersConfig: config,
      });
    }

    const preferred = preferredCompactionModel.trim();
    if (preferred.length > 0) {
      const explicit = getExplicitCompactionSuggestion({
        modelId: preferred,
        providersConfig: config,
      });
      if (explicit) {
        return explicit;
      }
    }

    return getHigherContextCompactionSuggestion({
      currentModel: compactionTargetModel,
      providersConfig: config,
    });
  }, [
    compactionTargetModel,
    showCompactionUI,
    isCompactionRecoveryFlow,
    providersConfig,
    preferredCompactionModel,
  ]);

  /**
   * Insert text into the chat input (for manual fallback on failure).
   * Uses a global event since the user is viewing this workspace when they click retry.
   */
  const insertIntoChatInput = useCallback((text: string, imageParts?: ImagePart[]): void => {
    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, {
        text,
        mode: "replace",
        imageParts,
      })
    );
  }, []);

  /**
   * Build continue message from the trigger user message.
   * Preserves skill invocation metadata so retry re-invokes the skill.
   */
  const buildContinueFromSource = useCallback(
    (source: Extract<DisplayedMessage, { type: "user" }>, model: string, agentId: string) => {
      const muxMetadata: MuxFrontendMetadata | undefined = source.agentSkill
        ? {
            type: "agent-skill",
            rawCommand: source.content,
            skillName: source.agentSkill.skillName,
            scope: source.agentSkill.scope,
          }
        : undefined;

      return buildContinueMessage({
        text: source.content,
        imageParts: source.imageParts,
        reviews: source.reviews,
        muxMetadata,
        model,
        agentId,
      });
    },
    []
  );

  /**
   * Manual retry: user clicked "Compact & retry" button.
   * On failure, falls back to inserting the command into chat input.
   */
  const retryWithCompaction = useCallback(async (): Promise<void> => {
    const suggestedCommandLine = formatCompactionCommandLine({
      model: compactionSuggestion?.modelArg,
    });

    if (!api || !triggerUserMessage) {
      insertIntoChatInput(suggestedCommandLine + "\n");
      return;
    }

    if (isMountedRef.current) {
      setIsRetryingWithCompaction(true);
    }

    try {
      const sendMessageOptions = buildSendMessageOptions(props.workspaceId);

      // Handle retry of a failed compaction request
      if (triggerUserMessage.compactionRequest) {
        if (!compactionSuggestion) {
          insertIntoChatInput(suggestedCommandLine + "\n");
          return;
        }

        const { maxOutputTokens, continueMessage } = triggerUserMessage.compactionRequest.parsed;
        const result = await executeCompaction({
          api,
          workspaceId: props.workspaceId,
          sendMessageOptions,
          model: compactionSuggestion.modelId,
          maxOutputTokens,
          continueMessage,
          editMessageId: triggerUserMessage.id,
        });

        if (!result.success) {
          console.error("Failed to retry compaction:", result.error);
          const slashCommand = formatCompactionCommandLine({
            model: compactionSuggestion.modelArg,
            maxOutputTokens,
          });
          const continueText = getCompactionContinueText(continueMessage);
          const fallbackText = continueText ? `${slashCommand}\n${continueText}` : slashCommand;
          insertIntoChatInput(
            fallbackText + (continueText ? "" : "\n"),
            continueMessage?.imageParts
          );
        }
        return;
      }

      // Handle compaction of a regular user message
      const continueMessage = buildContinueFromSource(
        triggerUserMessage,
        sendMessageOptions.model,
        sendMessageOptions.agentId ?? WORKSPACE_DEFAULTS.mode
      );

      if (!continueMessage) {
        insertIntoChatInput(suggestedCommandLine + "\n");
        return;
      }

      const result = await executeCompaction({
        api,
        workspaceId: props.workspaceId,
        sendMessageOptions,
        model: compactionSuggestion?.modelId,
        continueMessage,
        editMessageId: triggerUserMessage.id,
      });

      if (!result.success) {
        console.error("Failed to start compaction:", result.error);
        insertIntoChatInput(
          suggestedCommandLine + "\n" + triggerUserMessage.content,
          triggerUserMessage.imageParts
        );
      }
    } catch (error) {
      console.error("Failed to retry with compaction:", error);
      insertIntoChatInput(suggestedCommandLine + "\n");
    } finally {
      if (isMountedRef.current) {
        setIsRetryingWithCompaction(false);
      }
    }
  }, [
    api,
    compactionSuggestion,
    props.workspaceId,
    triggerUserMessage,
    insertIntoChatInput,
    buildContinueFromSource,
  ]);

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
      const sendMessageOptions = buildSendMessageOptions(props.workspaceId);
      const continueMessage = buildContinueFromSource(
        triggerUserMessage,
        sendMessageOptions.model,
        sendMessageOptions.agentId ?? WORKSPACE_DEFAULTS.mode
      );

      if (!continueMessage) {
        return false;
      }

      const result = await executeCompaction({
        api,
        workspaceId: props.workspaceId,
        sendMessageOptions,
        model: compactionSuggestion?.modelId,
        continueMessage,
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
  }, [
    api,
    compactionSuggestion?.modelId,
    props.workspaceId,
    triggerUserMessage,
    buildContinueFromSource,
  ]);

  // Auto-trigger compaction on context_exceeded for seamless recovery.
  const shouldAutoCompact =
    api &&
    isContextExceeded &&
    providersConfig !== undefined &&
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
