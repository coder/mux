import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/browser/components/ui/button";
import { useAPI } from "@/browser/contexts/API";
import { buildSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import { isGatewayFormat, toGatewayModel } from "@/browser/hooks/useGatewayModels";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { executeCompaction } from "@/browser/utils/chatCommands";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { cn } from "@/common/lib/utils";
import type { ImagePart, ProvidersConfigMap } from "@/common/orpc/types";
import type { DisplayedMessage } from "@/common/types/message";
import { buildContinueMessage } from "@/common/types/message";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";
import { getModelStats } from "@/common/utils/tokens/modelStats";
import { formatTokens } from "@/common/utils/tokens/tokenMeterUtils";

interface CompactionSuggestion {
  command: string;
  /** Model argument shown to the user (alias when available) */
  modelArg: string;
  /** Canonical model ID (provider:model) used for sending */
  modelId: string;
  displayName: string;
  provider: string;
  configuredVia: "provider" | "mux-gateway";
  maxInputTokens: number;
  currentMaxInputTokens: number;
}

function buildCompactionCommandLine(options: {
  modelArg: string;
  maxOutputTokens?: number;
}): string {
  let cmd = "/compact";
  if (typeof options.maxOutputTokens === "number") {
    cmd += ` -t ${options.maxOutputTokens}`;
  }
  cmd += ` -m ${options.modelArg}`;
  return cmd;
}

function findTriggerUserMessage(
  messages: DisplayedMessage[],
  streamErrorMessageId: string
): Extract<DisplayedMessage, { type: "user" }> | null {
  const errorIndex = messages.findIndex(
    (msg) => msg.type === "stream-error" && msg.id === streamErrorMessageId
  );
  if (errorIndex === -1) {
    return null;
  }

  for (let i = errorIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === "user") {
      return msg;
    }
  }

  return null;
}
function formatContextTokens(tokens: number): string {
  return formatTokens(tokens).replace(/\.0([kM])$/, "$1");
}
interface StreamErrorMessageProps {
  message: DisplayedMessage & { type: "stream-error" };
  workspaceId?: string;
  className?: string;
}

// Note: RetryBarrier now handles all retry UI. This component just displays the error.
export const StreamErrorMessage: React.FC<StreamErrorMessageProps> = ({
  message,
  workspaceId,
  className,
}) => {
  const showCount = message.errorCount !== undefined && message.errorCount > 1;

  const workspaceStore = useWorkspaceStoreRaw();
  const [isRetryingWithCompaction, setIsRetryingWithCompaction] = useState(false);
  const { api } = useAPI();
  const [providersConfig, setProvidersConfig] = useState<ProvidersConfigMap | null>(null);

  // This is a rare error state; we only need a snapshot of provider config to make a
  // best-effort suggestion (no subscriptions / real-time updates required).
  useEffect(() => {
    if (!api) return;
    if (message.errorType !== "context_exceeded") return;
    if (providersConfig) return;

    let active = true;
    (async () => {
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
  }, [api, message.errorType, providersConfig]);

  const compactionSuggestion = useMemo<CompactionSuggestion | null>(() => {
    // Opportunistic: only attempt suggestions when we can confidently identify the model.
    if (message.errorType !== "context_exceeded" || !message.model) {
      return null;
    }

    const currentStats = getModelStats(message.model);
    if (!currentStats?.max_input_tokens) {
      return null;
    }

    let best: CompactionSuggestion | null = null;

    for (const known of Object.values(KNOWN_MODELS)) {
      // "Configured" is intentionally fuzzy: we require either provider credentials,
      // or gateway routing enabled for that model (avoids suggesting unusable models).
      const hasProviderCreds = providersConfig?.[known.provider]?.apiKeySet === true;
      const routesThroughGateway = isGatewayFormat(toGatewayModel(known.id));
      if (!hasProviderCreds && !routesThroughGateway) {
        continue;
      }

      const candidateStats = getModelStats(known.id);
      if (!candidateStats?.max_input_tokens) {
        continue;
      }

      if (candidateStats.max_input_tokens <= currentStats.max_input_tokens) {
        continue;
      }

      if (!best || candidateStats.max_input_tokens > best.maxInputTokens) {
        const modelArg = known.aliases?.[0] ?? known.id;
        best = {
          command: `/compact -m ${modelArg}`,
          modelArg,
          modelId: known.id,
          displayName: formatModelDisplayName(known.providerModelId),
          provider: known.provider,
          configuredVia: hasProviderCreds ? "provider" : "mux-gateway",
          maxInputTokens: candidateStats.max_input_tokens,
          currentMaxInputTokens: currentStats.max_input_tokens,
        };
      }
    }

    return best;
  }, [message.errorType, message.model, providersConfig]);

  const triggerUserMessage = useMemo(() => {
    if (message.errorType !== "context_exceeded") {
      return null;
    }
    if (!workspaceId) {
      return null;
    }

    try {
      const workspaceState = workspaceStore.getWorkspaceState(workspaceId);
      return findTriggerUserMessage(workspaceState.messages, message.id);
    } catch {
      return null;
    }
  }, [message.errorType, message.id, workspaceId, workspaceStore]);

  async function handleRetryWithCompaction(): Promise<void> {
    if (!api || !workspaceId || !compactionSuggestion) {
      return;
    }

    const insertIntoChatInput = (text: string, imageParts?: ImagePart[]): void => {
      window.dispatchEvent(
        createCustomEvent(CUSTOM_EVENTS.INSERT_TO_CHAT_INPUT, {
          text,
          mode: "replace",
          imageParts,
        })
      );
    };

    setIsRetryingWithCompaction(true);
    try {
      // Read fresh values at click-time (workspace might have switched models).
      const sendMessageOptions = buildSendMessageOptions(workspaceId);

      // Best-effort: fall back to the nearest user message if we can't find the exact one.
      const source = triggerUserMessage;

      if (!source) {
        insertIntoChatInput(compactionSuggestion.command + "\n");
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
          const continueText = continueMessage?.text;
          insertIntoChatInput(
            buildCompactionCommandLine({
              modelArg: compactionSuggestion.modelArg,
              maxOutputTokens,
            }) + (continueText ? "\n" + continueText : "\n"),
            continueMessage?.imageParts
          );
        }

        return;
      }

      const continueMode = sendMessageOptions.mode === "plan" ? "plan" : "exec";
      const continueMessage = buildContinueMessage({
        text: source.content,
        imageParts: source.imageParts,
        model: sendMessageOptions.model,
        mode: continueMode,
      });

      if (!continueMessage) {
        insertIntoChatInput(compactionSuggestion.command + "\n");
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
        insertIntoChatInput(
          buildCompactionCommandLine({ modelArg: compactionSuggestion.modelArg }) +
            "\n" +
            source.content,
          source.imageParts
        );
      }
    } catch (error) {
      console.error("Failed to retry with compaction", error);
      insertIntoChatInput(compactionSuggestion.command + "\n");
    } finally {
      setIsRetryingWithCompaction(false);
    }
  }

  return (
    <div className={cn("bg-error-bg border border-error rounded px-5 py-4 my-3", className)}>
      <div className="font-primary text-error mb-3 flex items-center gap-2.5 text-[13px] font-semibold tracking-wide">
        <span className="text-base leading-none">●</span>
        <span>Stream Error</span>
        <code className="text-text-secondary bg-code-bg border-foreground/10 rounded-sm border px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase">
          {message.errorType}
        </code>
        {showCount && (
          <span className="text-error ml-auto rounded-sm bg-red-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide">
            ×{message.errorCount}
          </span>
        )}
      </div>
      <div className="text-foreground font-mono text-[13px] leading-relaxed break-words">
        {message.error}
      </div>

      {compactionSuggestion && (
        <div className="mt-3 text-[12px] leading-relaxed">
          <div className="text-text-secondary font-primary text-[11px] font-semibold tracking-wide uppercase">
            Suggestion
          </div>
          <div className="text-text-secondary mt-1">
            {(compactionSuggestion.configuredVia === "mux-gateway"
              ? "A Mux Gateway-enabled"
              : "A configured") + " model with a larger context window is available: "}
            <span className="text-foreground">{compactionSuggestion.displayName}</span> (
            {compactionSuggestion.provider};{" "}
            {formatContextTokens(compactionSuggestion.maxInputTokens)} tokens; current:{" "}
            {formatContextTokens(compactionSuggestion.currentMaxInputTokens)}).
          </div>
          {triggerUserMessage && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleRetryWithCompaction()}
                disabled={!api || !workspaceId || isRetryingWithCompaction}
              >
                {isRetryingWithCompaction
                  ? "Starting..."
                  : triggerUserMessage.compactionRequest
                    ? "Retry compaction"
                    : "Retry with compaction"}
              </Button>
              <span className="text-text-secondary text-[11px]">
                {triggerUserMessage.compactionRequest
                  ? "Runs /compact again using the suggested model."
                  : "Runs /compact using the suggested model, then re-sends your last message."}
              </span>
            </div>
          )}
          <code className="text-foreground bg-code-bg border-foreground/10 mt-2 inline-block rounded-sm border px-2 py-1 font-mono text-[12px]">
            {compactionSuggestion.command}
          </code>
        </div>
      )}
    </div>
  );
};
