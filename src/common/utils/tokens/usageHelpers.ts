/**
 * Helper functions for accumulating usage and provider metadata across multi-step tool calls.
 *
 * For multi-step tool calls, the AI SDK reports usage per-step. We need to:
 * - Sum usage across all steps for cost calculation
 * - Track last step's usage for context window display (inputTokens = actual context size)
 * - Accumulate provider-specific metadata (e.g., Anthropic cache creation tokens)
 */

import type { LanguageModelV2Usage } from "@ai-sdk/provider";

/**
 * Add two LanguageModelV2Usage values together.
 * Handles undefined first argument and undefined fields within usage objects.
 */
export function addUsage(
  a: LanguageModelV2Usage | undefined,
  b: LanguageModelV2Usage
): LanguageModelV2Usage {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b.outputTokens ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b.totalTokens ?? 0),
    cachedInputTokens: (a?.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
    reasoningTokens: (a?.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
  };
}

/**
 * Accumulate provider metadata across steps, specifically for cache creation tokens.
 *
 * For Anthropic, cache creation tokens are reported per-step and need to be summed.
 * Other provider metadata is taken from the latest step.
 */
export function accumulateProviderMetadata(
  existing: Record<string, unknown> | undefined,
  step: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!step) return existing;
  if (!existing) return step;

  // Extract cache creation tokens from both
  const existingCacheCreate =
    (existing.anthropic as { cacheCreationInputTokens?: number } | undefined)
      ?.cacheCreationInputTokens ?? 0;
  const stepCacheCreate =
    (step.anthropic as { cacheCreationInputTokens?: number } | undefined)
      ?.cacheCreationInputTokens ?? 0;

  const totalCacheCreate = existingCacheCreate + stepCacheCreate;

  // If no cache creation tokens to aggregate, just return step's metadata
  if (totalCacheCreate === 0) {
    return step;
  }

  // Merge with accumulated cache creation tokens
  return {
    ...step,
    anthropic: {
      ...(step.anthropic as Record<string, unknown> | undefined),
      cacheCreationInputTokens: totalCacheCreate,
    },
  };
}

/**
 * Fold per-step provider metadata from an AI SDK stream result into a single
 * record via {@link accumulateProviderMetadata}.
 *
 * `streamResult.providerMetadata` alone only reflects the LAST step: on
 * multi-step tool loops it drops earlier steps' Anthropic cache-write tokens
 * (`cacheCreationInputTokens`), which then get priced as ordinary input.
 * Headless callers (status generation, memory sweeps) use this before
 * recordHeadlessUsage so cache writes price as cache-create spend.
 */
export function accumulateStepsProviderMetadata(
  steps: ReadonlyArray<{ providerMetadata?: Record<string, unknown> }>
): Record<string, unknown> | undefined {
  let accumulated: Record<string, unknown> | undefined;
  for (const step of steps) {
    accumulated = accumulateProviderMetadata(accumulated, step.providerMetadata);
  }
  return accumulated;
}
