import React, { useEffect, useMemo, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { isGatewayFormat, toGatewayModel } from "@/browser/hooks/useGatewayModels";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { cn } from "@/common/lib/utils";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { DisplayedMessage } from "@/common/types/message";
import { getModelStats } from "@/common/utils/tokens/modelStats";

interface StreamErrorMessageProps {
  message: DisplayedMessage & { type: "stream-error" };
  className?: string;
}

// Note: RetryBarrier now handles all retry UI. This component just displays the error.
export const StreamErrorMessage: React.FC<StreamErrorMessageProps> = ({ message, className }) => {
  const showCount = message.errorCount !== undefined && message.errorCount > 1;

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

  const compactionSuggestion = useMemo(() => {
    // Opportunistic: only attempt suggestions when we can confidently identify the model.
    if (message.errorType !== "context_exceeded" || !message.model) {
      return null;
    }

    const currentStats = getModelStats(message.model);
    if (!currentStats?.max_input_tokens) {
      return null;
    }

    let best: { modelArg: string; maxInputTokens: number } | null = null;

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

      const modelArg = known.aliases?.[0] ?? known.id;
      if (!best || candidateStats.max_input_tokens > best.maxInputTokens) {
        best = { modelArg, maxInputTokens: candidateStats.max_input_tokens };
      }
    }

    return best ? `/compact -m ${best.modelArg}` : null;
  }, [message.errorType, message.model, providersConfig]);

  return (
    <div className={cn("bg-error-bg border border-error rounded px-5 py-4 my-3", className)}>
      <div className="font-primary text-error mb-3 flex items-center gap-2.5 text-[13px] font-semibold tracking-wide">
        <span className="text-base leading-none">●</span>
        <span>Stream Error</span>
        <span className="text-secondary rounded-sm bg-black/40 px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase">
          {message.errorType}
        </span>
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
        <div className="mt-3 text-[12px]">
          <div className="text-secondary font-primary text-[11px] font-semibold tracking-wide uppercase">
            Suggestion
          </div>
          <code className="text-foreground mt-1 inline-block rounded-sm bg-black/40 px-2 py-1 font-mono text-[12px]">
            {compactionSuggestion}
          </code>
        </div>
      )}
    </div>
  );
};
