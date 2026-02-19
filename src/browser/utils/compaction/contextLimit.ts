/**
 * Shared context limit utilities for compaction logic.
 *
 * Used by autoCompactionCheck and contextSwitchCheck to calculate
 * effective context limits accounting for 1M context toggle.
 */

import type { ProvidersConfigMap } from "@/common/orpc/types";
import { supports1MContext } from "@/common/utils/ai/models";
import { getModelContextWindowOverride } from "@/common/utils/providers/modelEntries";
import { getModelStats } from "@/common/utils/tokens/modelStats";

/**
 * Get effective context limit for a model, accounting for custom overrides and 1M toggle.
 *
 * @param model - Model ID (e.g., "anthropic:claude-sonnet-4-5")
 * @param use1M - Whether 1M context is enabled in settings
 * @param providersConfig - Provider configuration map for custom model overrides
 * @returns Max input tokens, or null if no limit is known
 */
export function getEffectiveContextLimit(
  model: string,
  use1M: boolean,
  providersConfig: ProvidersConfigMap | null = null
): number | null {
  const customOverride = getModelContextWindowOverride(model, providersConfig);
  const stats = getModelStats(model);
  const baseLimit = customOverride ?? stats?.max_input_tokens ?? null;
  if (!baseLimit) return null;

  // Sonnet: 1M optional (toggle). Gemini: always 1M (native).
  if (supports1MContext(model) && use1M) return 1_000_000;
  return baseLimit;
}
