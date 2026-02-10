/**
 * Shared context limit utilities.
 *
 * Used by token meter display, auto-compaction, and context-switch checks
 * to calculate effective context limits accounting for the 1M context toggle.
 */

import { getModelStats } from "./modelStats";
import { supports1MContext } from "../ai/models";

/**
 * Get effective context limit for a model, accounting for 1M toggle.
 *
 * @param model - Model ID (e.g., "anthropic:claude-sonnet-4-5")
 * @param use1M - Whether 1M context is enabled in settings
 * @returns Max input tokens, or null if model stats unavailable
 */
export function getEffectiveContextLimit(model: string, use1M: boolean): number | null {
  const stats = getModelStats(model);
  if (!stats?.max_input_tokens) return null;

  // Sonnet: 1M optional (toggle). Gemini: always 1M (native).
  if (supports1MContext(model) && use1M) return 1_000_000;
  return stats.max_input_tokens;
}
