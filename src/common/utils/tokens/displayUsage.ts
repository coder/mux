/**
 * Display usage utilities for renderer
 *
 * IMPORTANT: This file must NOT import tokenizer to avoid pulling Node.js
 * dependencies into the renderer bundle.
 */

import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { getModelStats } from "./modelStats";
import type { ChatUsageDisplay } from "./usageAggregator";
import type { MuxMessage } from "@/common/types/message";

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

  // Detect provider from model string
  const isOpenAI = model.startsWith("openai:");

  // For OpenAI, subtract cached tokens to get uncached input tokens
  const inputTokens = isOpenAI ? Math.max(0, rawInputTokens - cachedTokens) : rawInputTokens;

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

  // Calculate costs based on model stats (undefined if model unknown)
  let inputCost: number | undefined;
  let cachedCost: number | undefined;
  let cacheCreateCost: number | undefined;
  let outputCost: number | undefined;
  let reasoningCost: number | undefined;

  if (modelStats) {
    inputCost = inputTokens * modelStats.input_cost_per_token;
    cachedCost = cachedTokens * (modelStats.cache_read_input_token_cost ?? 0);
    cacheCreateCost = cacheCreateTokens * (modelStats.cache_creation_input_token_cost ?? 0);
    outputCost = outputWithoutReasoning * modelStats.output_cost_per_token;
    reasoningCost = reasoningTokens * modelStats.output_cost_per_token;
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

export function getUsageHistory(
  messages: MuxMessage[],
  fallbackModel?: string
): ChatUsageDisplay[] {
  // Extract usage from assistant messages
  const usageHistory: ChatUsageDisplay[] = [];
  let cumulativeHistorical: ChatUsageDisplay | undefined;

  for (const msg of messages) {
    if (msg.role === "assistant") {
      // Check for historical usage from compaction summaries
      // This preserves costs from messages deleted during compaction
      if (msg.metadata?.historicalUsage) {
        cumulativeHistorical = msg.metadata.historicalUsage;
      }

      // Extract current message's usage
      if (msg.metadata?.usage) {
        // Use the model from this specific message (not global)
        const model = msg.metadata.model ?? fallbackModel ?? "unknown";

        const usage = createDisplayUsage(msg.metadata.usage, model, msg.metadata.providerMetadata);

        if (usage) {
          usageHistory.push(usage);
        }
      }
    }
  }

  // If we have historical usage from a compaction, prepend it to history
  // This ensures costs from pre-compaction messages are included in totals
  if (cumulativeHistorical) {
    usageHistory.unshift(cumulativeHistorical);
  }

  return usageHistory;
}
