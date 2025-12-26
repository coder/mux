import React, { useMemo, useState } from "react";

import { SendHorizontal } from "lucide-react";

import type { StreamingMessageAggregator } from "mux/browser/utils/messages/StreamingMessageAggregator";
import { getSendOptionsFromStorage } from "mux/browser/utils/messages/sendOptions";

import { useAPI } from "mux/browser/contexts/API";
import { ModeProvider, useMode } from "mux/browser/contexts/ModeContext";
import { ThinkingProvider } from "mux/browser/contexts/ThinkingContext";
import { useThinkingLevel } from "mux/browser/hooks/useThinkingLevel";
import { usePersistedState } from "mux/browser/hooks/usePersistedState";
import { useModelsFromSettings } from "mux/browser/hooks/useModelsFromSettings";
import { migrateGatewayModel } from "mux/browser/hooks/useGatewayModels";
import { useProviderOptions } from "mux/browser/hooks/useProviderOptions";
import { useAutoCompactionSettings } from "mux/browser/hooks/useAutoCompactionSettings";

import { ModelSelector } from "mux/browser/components/ModelSelector";
import { ThinkingSliderComponent } from "mux/browser/components/ThinkingSlider";
import { ContextUsageIndicatorButton } from "mux/browser/components/ContextUsageIndicatorButton";
import { ModeSelector } from "mux/browser/components/ModeSelector";
import { Tooltip, TooltipTrigger, TooltipContent } from "mux/browser/components/ui/tooltip";

import { calculateTokenMeterData } from "mux/common/utils/tokens/tokenMeterUtils";
import { createDisplayUsage } from "mux/common/utils/tokens/displayUsage";
import type { ChatUsageDisplay } from "mux/common/utils/tokens/usageAggregator";
import { enforceThinkingPolicy } from "mux/common/utils/thinking/policy";
import { cn } from "mux/common/lib/utils";
import { getInputKey, getModelKey } from "mux/common/constants/storage";

function getLastContextUsage(
  aggregator: StreamingMessageAggregator,
  fallbackModel: string | null
): ChatUsageDisplay | undefined {
  const messages = aggregator.getAllMessages();

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.role !== "assistant") {
      continue;
    }

    if (msg.metadata?.compacted) {
      continue;
    }

    const rawUsage = msg.metadata?.contextUsage;
    if (!rawUsage) {
      continue;
    }

    const providerMetadata = msg.metadata?.contextProviderMetadata ?? msg.metadata?.providerMetadata;
    const model = msg.metadata?.model ?? fallbackModel ?? "unknown";

    return createDisplayUsage(rawUsage, model, providerMetadata);
  }

  return undefined;
}

function ChatComposerInner(props: {
  workspaceId: string;
  disabled: boolean;
  placeholder: string;
  aggregator: StreamingMessageAggregator | null;
  onSendComplete: () => void;
  onNotice: (notice: { level: "info" | "error"; message: string }) => void;
}): JSX.Element {
  const apiState = useAPI();
  const api = apiState.api;

  const [mode, setMode] = useMode();
  const [thinkingLevel] = useThinkingLevel();

  const { options: providerOptions } = useProviderOptions();
  const use1M = providerOptions.anthropic?.use1MContext ?? false;

  const {
    models,
    hiddenModels,
    hideModel,
    unhideModel,
    ensureModelInSettings,
    defaultModel,
    setDefaultModel,
  } = useModelsFromSettings();

  const modelKey = getModelKey(props.workspaceId);
  const [preferredModel, setPreferredModel] = usePersistedState<string>(modelKey, defaultModel, {
    listener: true,
  });

  const baseModel = migrateGatewayModel(preferredModel);

  const inputKey = getInputKey(props.workspaceId);
  const [input, setInput] = usePersistedState<string>(inputKey, "", { listener: true });

  const [isSending, setIsSending] = useState(false);

  const aggregator = props.aggregator;
  const usageModelFromAggregator = aggregator?.getCurrentModel() ?? null;

  // Note: avoid memoizing against the aggregator reference.
  // The aggregator mutates in-place as events stream in.
  const lastContextUsage = aggregator
    ? getLastContextUsage(aggregator, usageModelFromAggregator)
    : undefined;

  const liveUsage = (() => {
    if (!aggregator) {
      return undefined;
    }

    const activeStreamMessageId = aggregator.getActiveStreamMessageId();
    if (!activeStreamMessageId) {
      return undefined;
    }

    const model = usageModelFromAggregator;
    if (!model) {
      return undefined;
    }

    const rawUsage = aggregator.getActiveStreamUsage(activeStreamMessageId);
    const providerMetadata = aggregator.getActiveStreamStepProviderMetadata(activeStreamMessageId);

    return rawUsage ? createDisplayUsage(rawUsage, model, providerMetadata) : undefined;
  })();

  const lastUsage = liveUsage ?? lastContextUsage;
  const usageModel = lastUsage?.model ?? usageModelFromAggregator;

  const contextUsageData = useMemo(() => {
    return lastUsage
      ? calculateTokenMeterData(lastUsage, usageModel ?? "unknown", use1M, false)
      : { segments: [], totalTokens: 0, totalPercentage: 0 };
  }, [lastUsage, usageModel, use1M]);

  const autoCompactionSettings = useAutoCompactionSettings(props.workspaceId, usageModel);

  const canSend =
    !props.disabled &&
    !isSending &&
    input.trim().length > 0 &&
    apiState.status === "connected" &&
    Boolean(api);

  const onModelChange = (model: string) => {
    const canonicalModel = migrateGatewayModel(model);
    ensureModelInSettings(canonicalModel);
    setPreferredModel(canonicalModel);

    if (!api) {
      return;
    }

    const effectiveThinkingLevel = enforceThinkingPolicy(canonicalModel, thinkingLevel);

    api.workspace
      .updateAISettings({
        workspaceId: props.workspaceId,
        aiSettings: { model: canonicalModel, thinkingLevel: effectiveThinkingLevel },
      })
      .catch(() => {
        // Best-effort only.
      });
  };

  const onSend = async () => {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    if (!api) {
      props.onNotice({ level: "error", message: "Not connected to mux server." });
      return;
    }

    setIsSending(true);
    setInput("");

    try {
      const options = getSendOptionsFromStorage(props.workspaceId);

      const result = await api.workspace.sendMessage({
        workspaceId: props.workspaceId,
        message: trimmed,
        options,
      });

      if (!result.success) {
        const errorString =
          typeof result.error === "string" ? result.error : JSON.stringify(result.error, null, 2);
        props.onNotice({ level: "error", message: `Send failed: ${errorString}` });
        setInput(trimmed);
        return;
      }

      props.onSendComplete();
    } catch (error) {
      const errorString = error instanceof Error ? error.message : String(error);
      props.onNotice({ level: "error", message: `Send failed: ${errorString}` });
      setInput(trimmed);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <textarea
        className="border-input bg-background text-foreground placeholder:text-muted w-full resize-y rounded-md border px-3 py-2 text-sm"
        placeholder={props.placeholder}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        disabled={props.disabled}
        rows={3}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void onSend();
          }
        }}
      />

      <div className="@container flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex items-center" data-component="ModelSelectorGroup">
          <ModelSelector
            value={baseModel}
            onChange={onModelChange}
            models={models}
            hiddenModels={hiddenModels}
            defaultModel={defaultModel}
            onSetDefaultModel={setDefaultModel}
            onHideModel={hideModel}
            onUnhideModel={unhideModel}
          />
        </div>

        <div className="flex items-center [&_.thinking-slider]:[@container(max-width:550px)]:hidden">
          <ThinkingSliderComponent modelString={baseModel} />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <ContextUsageIndicatorButton data={contextUsageData} autoCompaction={autoCompactionSettings} />
          <ModeSelector mode={mode} onChange={setMode} />

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => void onSend()}
                disabled={!canSend}
                aria-label="Send message"
                className={cn(
                  "inline-flex items-center gap-1 rounded-sm border border-border-light px-1.5 py-0.5 text-[11px] font-medium text-white transition-colors duration-200 disabled:opacity-50",
                  mode === "plan"
                    ? "bg-plan-mode hover:bg-plan-mode-hover disabled:hover:bg-plan-mode"
                    : "bg-exec-mode hover:bg-exec-mode-hover disabled:hover:bg-exec-mode"
                )}
              >
                <SendHorizontal className="h-3.5 w-3.5" strokeWidth={2.5} />
              </button>
            </TooltipTrigger>
            <TooltipContent align="center">Send message (Ctrl+Enter)</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="text-muted text-[11px]">Tip: Press Ctrl+Enter (or Cmd+Enter) to send.</div>
    </div>
  );
}

export function ChatComposer(props: {
  workspaceId: string;
  disabled: boolean;
  placeholder: string;
  aggregator: StreamingMessageAggregator | null;
  onSendComplete: () => void;
  onNotice: (notice: { level: "info" | "error"; message: string }) => void;
}): JSX.Element {
  return (
    <ModeProvider workspaceId={props.workspaceId}>
      <ThinkingProvider workspaceId={props.workspaceId}>
        <ChatComposerInner
          workspaceId={props.workspaceId}
          disabled={props.disabled}
          placeholder={props.placeholder}
          aggregator={props.aggregator}
          onSendComplete={props.onSendComplete}
          onNotice={props.onNotice}
        />
      </ThinkingProvider>
    </ModeProvider>
  );
}
