/**
 * Helpers for best-effort compaction suggestions.
 *
 * Used by RetryBarrier to offer "Compact & retry" when we hit context limits.
 */

import { isGatewayFormat, toGatewayModel } from "@/browser/hooks/useGatewayModels";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";
import { getModelStats } from "@/common/utils/tokens/modelStats";

export interface CompactionSuggestion {
  /** Model argument shown to the user (alias when available) */
  modelArg: string;
  /** Canonical model ID (provider:model) used for sending */
  modelId: string;
  displayName: string;
  maxInputTokens: number;
}

/**
 * Find a configured known model with a strictly larger context window than `currentModel`.
 */
export function getHigherContextCompactionSuggestion(options: {
  currentModel: string;
  providersConfig: ProvidersConfigMap | null;
}): CompactionSuggestion | null {
  const currentStats = getModelStats(options.currentModel);
  if (!currentStats?.max_input_tokens) {
    return null;
  }

  let best: CompactionSuggestion | null = null;

  for (const known of Object.values(KNOWN_MODELS)) {
    // "Configured" is intentionally fuzzy: we require either provider credentials,
    // or gateway routing enabled for that model (avoids suggesting unusable models).
    const hasProviderCreds = options.providersConfig?.[known.provider]?.apiKeySet === true;
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
      best = {
        modelArg: known.aliases?.[0] ?? known.id,
        modelId: known.id,
        displayName: formatModelDisplayName(known.providerModelId),
        maxInputTokens: candidateStats.max_input_tokens,
      };
    }
  }

  return best;
}
