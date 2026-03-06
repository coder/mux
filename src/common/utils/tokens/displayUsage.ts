/**
 * Display usage utilities for renderer
 *
 * IMPORTANT: This file must NOT import tokenizer to avoid pulling Node.js
 * dependencies into the renderer bundle.
 */

import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { getModelStats, type ModelStats } from "./modelStats";
import type { ChatUsageDisplay } from "./usageAggregator";

interface UsageCostInputs {
  inputTokens: number;
  cachedTokens: number;
  cacheCreateTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

interface UsageCosts {
  inputCost: number;
  cachedCost: number;
  cacheCreateCost: number;
  outputCost: number;
  reasoningCost: number;
}

function selectCostRate(
  modelStats: ModelStats,
  promptContextTokens: number,
  baseRate: number,
  highContextRate?: number
): number {
  if (
    highContextRate != null &&
    modelStats.tiered_pricing_threshold_tokens != null &&
    promptContextTokens > modelStats.tiered_pricing_threshold_tokens
  ) {
    return highContextRate;
  }

  return baseRate;
}

function calculateUsageCosts(modelStats: ModelStats, usage: UsageCostInputs): UsageCosts {
  // Long-context providers price the entire prompt tier (input/cache reads/cache writes)
  // based on prompt size, then reuse that same tier for output/reasoning charges.
  const promptContextTokens = usage.inputTokens + usage.cachedTokens + usage.cacheCreateTokens;
  const inputRate = selectCostRate(
    modelStats,
    promptContextTokens,
    modelStats.input_cost_per_token,
    modelStats.input_cost_per_token_above_200k_tokens
  );
  const cachedRate = selectCostRate(
    modelStats,
    promptContextTokens,
    modelStats.cache_read_input_token_cost ?? 0,
    modelStats.cache_read_input_token_cost_above_200k_tokens
  );
  const cacheCreateRate = selectCostRate(
    modelStats,
    promptContextTokens,
    modelStats.cache_creation_input_token_cost ?? 0,
    modelStats.cache_creation_input_token_cost_above_200k_tokens
  );
  const outputRate = selectCostRate(
    modelStats,
    promptContextTokens,
    modelStats.output_cost_per_token,
    modelStats.output_cost_per_token_above_200k_tokens
  );

  return {
    inputCost: usage.inputTokens * inputRate,
    cachedCost: usage.cachedTokens * cachedRate,
    cacheCreateCost: usage.cacheCreateTokens * cacheCreateRate,
    outputCost: usage.outputTokens * outputRate,
    reasoningCost: usage.reasoningTokens * outputRate,
  };
}

/**
 * Create a display-friendly usage object from AI SDK usage
 *
 * This function transforms raw AI SDK usage data into a format suitable
 * for display in the UI. It does NOT require the tokenizer.
 */
export function createDisplayUsage(
  usage: LanguageModelV2Usage | undefined,
  model: string,
  providerMetadata?: Record<string, unknown>,
  metadataModelOverride?: string
): ChatUsageDisplay | undefined {
  if (!usage) return undefined;

  // AI SDK v6 unified semantics: ALL providers now report inputTokens INCLUSIVE
  // of cached tokens. Previously Anthropic excluded cached tokens from inputTokens
  // but v6 changed this to match OpenAI/Google (inputTokens = total input including
  // cache_read + cache_write). We always subtract both cachedInputTokens and
  // cacheCreateTokens to get the true non-cached input count.
  const cachedTokens = usage.cachedInputTokens ?? 0;
  const rawInputTokens = usage.inputTokens ?? 0;

  // Extract cache creation tokens from provider metadata (Anthropic-specific)
  // Needed before computing inputTokens since we subtract it from the total.
  const cacheCreateTokens =
    (providerMetadata?.anthropic as { cacheCreationInputTokens?: number } | undefined)
      ?.cacheCreationInputTokens ?? 0;

  // Subtract both cache-read and cache-create tokens to isolate non-cached input.
  // Math.max guards against pre-v6 historical data where inputTokens already excluded
  // cache tokens (subtraction would go negative).
  const inputTokens = Math.max(0, rawInputTokens - cachedTokens - cacheCreateTokens);

  // Extract reasoning tokens with fallback to provider metadata (OpenAI-specific)
  const reasoningTokens =
    usage.reasoningTokens ??
    (providerMetadata?.openai as { reasoningTokens?: number } | undefined)?.reasoningTokens ??
    0;

  // Calculate output tokens excluding reasoning
  const outputWithoutReasoning = Math.max(0, (usage.outputTokens ?? 0) - reasoningTokens);

  // Get model stats for cost calculation
  const modelStats = getModelStats(metadataModelOverride ?? model);

  const costsIncluded =
    (providerMetadata?.mux as { costsIncluded?: boolean } | undefined)?.costsIncluded === true;

  // Calculate costs based on model stats (undefined if model unknown)
  let inputCost: number | undefined;
  let cachedCost: number | undefined;
  let cacheCreateCost: number | undefined;
  let outputCost: number | undefined;
  let reasoningCost: number | undefined;

  if (modelStats) {
    const costs = calculateUsageCosts(modelStats, {
      inputTokens,
      cachedTokens,
      cacheCreateTokens,
      outputTokens: outputWithoutReasoning,
      reasoningTokens,
    });
    inputCost = costs.inputCost;
    cachedCost = costs.cachedCost;
    cacheCreateCost = costs.cacheCreateCost;
    outputCost = costs.outputCost;
    reasoningCost = costs.reasoningCost;
  }

  if (costsIncluded) {
    inputCost = 0;
    cachedCost = 0;
    cacheCreateCost = 0;
    outputCost = 0;
    reasoningCost = 0;
  }

  return {
    ...(costsIncluded ? { costsIncluded: true } : {}),
    input: {
      tokens: inputTokens,
      cost_usd: inputCost,
    },
    cached: {
      tokens: cachedTokens,
      cost_usd: cachedCost,
    },
    cacheCreate: {
      tokens: cacheCreateTokens,
      cost_usd: cacheCreateCost,
    },
    output: {
      tokens: outputWithoutReasoning,
      cost_usd: outputCost,
    },
    reasoning: {
      tokens: reasoningTokens,
      cost_usd: reasoningCost,
    },
    model, // Include model for display purposes
  };
}

/**
 * Recompute cost_usd values in an existing ChatUsageDisplay using updated model pricing.
 *
 * Used when provider config changes (e.g., model mapping updated) to refresh
 * persisted session cost aggregates without discarding the raw token counts.
 */
export function recomputeUsageCosts(
  usage: ChatUsageDisplay,
  metadataModel: string
): ChatUsageDisplay {
  const modelStats = getModelStats(metadataModel);

  if (!modelStats) {
    // Unknown model — strip costs and flag as unknown
    return {
      input: { tokens: usage.input.tokens },
      cached: { tokens: usage.cached.tokens },
      cacheCreate: { tokens: usage.cacheCreate.tokens },
      output: { tokens: usage.output.tokens },
      reasoning: { tokens: usage.reasoning.tokens },
      model: usage.model,
      hasUnknownCosts: true,
    };
  }

  const costs = calculateUsageCosts(modelStats, {
    inputTokens: usage.input.tokens,
    cachedTokens: usage.cached.tokens,
    cacheCreateTokens: usage.cacheCreate.tokens,
    outputTokens: usage.output.tokens,
    reasoningTokens: usage.reasoning.tokens,
  });

  return {
    input: {
      tokens: usage.input.tokens,
      cost_usd: costs.inputCost,
    },
    cached: {
      tokens: usage.cached.tokens,
      cost_usd: costs.cachedCost,
    },
    cacheCreate: {
      tokens: usage.cacheCreate.tokens,
      cost_usd: costs.cacheCreateCost,
    },
    output: {
      tokens: usage.output.tokens,
      cost_usd: costs.outputCost,
    },
    reasoning: {
      tokens: usage.reasoning.tokens,
      cost_usd: costs.reasoningCost,
    },
    model: usage.model,
  };
}
