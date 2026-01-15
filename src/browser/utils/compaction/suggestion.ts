/**
 * Helpers for best-effort compaction suggestions.
 *
 * Used by RetryBarrier to offer "Compact & retry" when we hit context limits.
 */

import { isGatewayFormat, toGatewayModel } from "@/browser/hooks/useGatewayModels";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { normalizeGatewayModel } from "@/common/utils/ai/models";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";
import { getModelStats } from "@/common/utils/tokens/modelStats";

export interface CompactionSuggestion {
  kind: "preferred" | "higher_context";
  /** Model argument shown to the user (alias when available) */
  modelArg: string;
  /** Canonical model ID (provider:model) used for sending */
  modelId: string;
  displayName: string;
  /**
   * Best-effort context size for display.
   *
   * Null when we don't have model stats for this model ID.
   */
  maxInputTokens: number | null;
}

export function getExplicitCompactionSuggestion(options: {
  modelId: string;
  providersConfig: ProvidersConfigMap | null;
}): CompactionSuggestion | null {
  const modelId = options.modelId.trim();
  if (modelId.length === 0) {
    return null;
  }

  const normalized = normalizeGatewayModel(modelId);
  const colonIndex = normalized.indexOf(":");
  const provider = colonIndex === -1 ? null : normalized.slice(0, colonIndex);
  const isProviderConfigured = provider
    ? options.providersConfig?.[provider]?.isConfigured === true
    : false;

  // "Configured" is intentionally fuzzy: we require either provider credentials,
  // or gateway routing enabled for that model (avoids suggesting unusable models).
  const routesThroughGateway = isGatewayFormat(toGatewayModel(modelId));
  if (!isProviderConfigured && !routesThroughGateway) {
    return null;
  }

  const stats = getModelStats(normalized);

  // Prefer a stable alias for built-in known models.
  const known = Object.values(KNOWN_MODELS).find((m) => m.id === normalized);
  const modelArg = known?.aliases?.[0] ?? modelId;

  const providerModelId = colonIndex === -1 ? normalized : normalized.slice(colonIndex + 1);
  const displayName = formatModelDisplayName(known?.providerModelId ?? providerModelId);

  return {
    kind: "preferred",
    modelArg,
    modelId,
    displayName,
    maxInputTokens: stats?.max_input_tokens ?? null,
  };
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
    const isProviderConfigured = options.providersConfig?.[known.provider]?.isConfigured === true;
    const routesThroughGateway = isGatewayFormat(toGatewayModel(known.id));
    if (!isProviderConfigured && !routesThroughGateway) {
      continue;
    }

    const candidateStats = getModelStats(known.id);
    if (!candidateStats?.max_input_tokens) {
      continue;
    }

    if (candidateStats.max_input_tokens <= currentStats.max_input_tokens) {
      continue;
    }

    const bestMax = best?.maxInputTokens ?? 0;
    if (!best || candidateStats.max_input_tokens > bestMax) {
      best = {
        kind: "higher_context",
        modelArg: known.aliases?.[0] ?? known.id,
        modelId: known.id,
        displayName: formatModelDisplayName(known.providerModelId),
        maxInputTokens: candidateStats.max_input_tokens,
      };
    }
  }

  return best;
}
