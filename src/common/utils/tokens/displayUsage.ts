/**
 * Display usage utilities for renderer
 *
 * IMPORTANT: This file must NOT import tokenizer to avoid pulling Node.js
 * dependencies into the renderer bundle.
 */

import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { ModelStats } from "./modelStats";
import { getModelStats } from "./modelStats";
import type { ChatUsageDisplay } from "./usageAggregator";
import { normalizeGatewayModel } from "../ai/models";

/**
 * Get tier-adjusted costs from model stats based on OpenAI service tier.
 * Falls back to standard pricing if tier-specific costs aren't available.
 */
function getTierCosts(
  modelStats: ModelStats,
  serviceTier: string | undefined
): {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
} {
  const standardCosts = {
    inputCost: modelStats.input_cost_per_token,
    outputCost: modelStats.output_cost_per_token,
    cacheReadCost: modelStats.cache_read_input_token_cost ?? 0,
  };

  if (serviceTier === "flex") {
    return {
      inputCost: modelStats.input_cost_per_token_flex ?? standardCosts.inputCost,
      outputCost: modelStats.output_cost_per_token_flex ?? standardCosts.outputCost,
      cacheReadCost: modelStats.cache_read_input_token_cost_flex ?? standardCosts.cacheReadCost,
    };
  }

  if (serviceTier === "priority") {
    return {
      inputCost: modelStats.input_cost_per_token_priority ?? standardCosts.inputCost,
      outputCost: modelStats.output_cost_per_token_priority ?? standardCosts.outputCost,
      cacheReadCost: modelStats.cache_read_input_token_cost_priority ?? standardCosts.cacheReadCost,
    };
  }

  // "default", "auto", or undefined → standard pricing
  return standardCosts;
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
  providerMetadata?: Record<string, unknown>
): ChatUsageDisplay | undefined {
  if (!usage) return undefined;

  // Provider-specific token handling:
  // - OpenAI: inputTokens is INCLUSIVE of cachedInputTokens
  // - Anthropic: inputTokens EXCLUDES cachedInputTokens
  const cachedTokens = usage.cachedInputTokens ?? 0;
  const rawInputTokens = usage.inputTokens ?? 0;

  // Normalize gateway models (e.g., "mux-gateway:openai/gpt-5.2" → "openai:gpt-5.2")
  // before detecting provider, so gateway-routed requests get correct handling
  const normalizedModel = normalizeGatewayModel(model);

  // Detect provider from normalized model string
  const isOpenAI = normalizedModel.startsWith("openai:");
  const isGoogle = normalizedModel.startsWith("google:");

  // OpenAI and Google report inputTokens INCLUSIVE of cachedInputTokens
  // Anthropic reports them separately (inputTokens EXCLUDES cached)
  // Subtract cached tokens for providers that include them to avoid double-counting
  const inputTokens =
    isOpenAI || isGoogle ? Math.max(0, rawInputTokens - cachedTokens) : rawInputTokens;

  // Extract cache creation tokens from provider metadata (Anthropic-specific)
  const cacheCreateTokens =
    (providerMetadata?.anthropic as { cacheCreationInputTokens?: number } | undefined)
      ?.cacheCreationInputTokens ?? 0;

  // Extract reasoning tokens with fallback to provider metadata (OpenAI-specific)
  const reasoningTokens =
    usage.reasoningTokens ??
    (providerMetadata?.openai as { reasoningTokens?: number } | undefined)?.reasoningTokens ??
    0;

  // Calculate output tokens excluding reasoning
  const outputWithoutReasoning = Math.max(0, (usage.outputTokens ?? 0) - reasoningTokens);

  // Get model stats for cost calculation
  const modelStats = getModelStats(model);

  // Extract OpenAI service tier from response metadata (actual tier used, not requested)
  // AI SDK returns serviceTier in providerMetadata.openai.serviceTier
  const serviceTier = isOpenAI
    ? (providerMetadata?.openai as { serviceTier?: string } | undefined)?.serviceTier
    : undefined;

  // Calculate costs based on model stats (undefined if model unknown)
  let inputCost: number | undefined;
  let cachedCost: number | undefined;
  let cacheCreateCost: number | undefined;
  let outputCost: number | undefined;
  let reasoningCost: number | undefined;

  if (modelStats) {
    // Get tier-adjusted costs (flex ~50% cheaper, priority ~2x)
    const tierCosts = getTierCosts(modelStats, serviceTier);

    inputCost = inputTokens * tierCosts.inputCost;
    cachedCost = cachedTokens * tierCosts.cacheReadCost;
    cacheCreateCost = cacheCreateTokens * (modelStats.cache_creation_input_token_cost ?? 0);
    outputCost = outputWithoutReasoning * tierCosts.outputCost;
    reasoningCost = reasoningTokens * tierCosts.outputCost;
  }

  return {
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
