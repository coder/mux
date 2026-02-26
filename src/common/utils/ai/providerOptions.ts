/**
 * Provider-specific request configuration for AI SDK
 *
 * Builds both `providerOptions` (thinking, reasoning) and per-request HTTP
 * `headers` (e.g. Anthropic 1M context beta) for streamText(). Both builders
 * share the same gateway-normalization logic and provider branching.
 */

import type { AnthropicProviderOptions } from "@ai-sdk/anthropic";
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import type { XaiProviderOptions } from "@ai-sdk/xai";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import type { ThinkingLevel } from "@/common/types/thinking";
import {
  getAnthropicEffort,
  ANTHROPIC_THINKING_BUDGETS,
  GEMINI_THINKING_BUDGETS,
  OPENAI_REASONING_EFFORT,
  OPENROUTER_REASONING_EFFORT,
} from "@/common/types/thinking";
import { log } from "@/node/services/log";
import type { MuxMessage } from "@/common/types/message";
import { normalizeGatewayModel, supports1MContext } from "./models";

/**
 * OpenRouter reasoning options
 * @see https://openrouter.ai/docs/use-cases/reasoning-tokens
 */
interface OpenRouterReasoningOptions {
  reasoning?: {
    enabled?: boolean;
    exclude?: boolean;
    effort?: "low" | "medium" | "high";
  };
}

/**
 * Provider-specific options structure for AI SDK
 */
type ProviderOptions =
  | { anthropic: AnthropicProviderOptions }
  | { openai: OpenAIResponsesProviderOptions }
  | { google: GoogleGenerativeAIProviderOptions }
  | { openrouter: OpenRouterReasoningOptions }
  | { xai: XaiProviderOptions }
  | Record<string, never>; // Empty object for unsupported providers

const OPENAI_REASONING_SUMMARY_UNSUPPORTED_MODELS = new Set<string>([
  // Codex Spark rejects reasoning.summary with:
  // "Unsupported parameter: 'reasoning.summary' ...".
  "gpt-5.3-codex-spark",
]);

function supportsOpenAIReasoningSummary(modelName: string): boolean {
  return !OPENAI_REASONING_SUMMARY_UNSUPPORTED_MODELS.has(modelName);
}

/**
 * Build provider-specific options for AI SDK based on thinking level
 *
 * This function configures provider-specific options for supported providers:
 * 1. Enable reasoning traces (transparency into model's thought process)
 * 2. Set reasoning level (control depth of reasoning based on task complexity)
 * 3. Enable parallel tool calls (allow concurrent tool execution)
 * 4. Extract previousResponseId for OpenAI persistence (when available)
 *
 * @param modelString - Full model string (e.g., "anthropic:claude-opus-4-1")
 * @param thinkingLevel - Unified thinking level (must be pre-clamped via enforceThinkingPolicy)
 * @param messages - Conversation history to extract previousResponseId from
 * @param lostResponseIds - Optional callback to check if a responseId has been invalidated by OpenAI
 * @param muxProviderOptions - Optional provider overrides from config
 * @param workspaceId - Optional for non-OpenAI providers
 * @param openaiTruncationMode - Optional truncation mode for OpenAI responses (auto/disabled)
 * @returns Provider options object for AI SDK
 */
export function buildProviderOptions(
  modelString: string,
  thinkingLevel: ThinkingLevel,
  messages?: MuxMessage[],
  lostResponseIds?: (id: string) => boolean,
  muxProviderOptions?: MuxProviderOptions,
  workspaceId?: string, // Optional for non-OpenAI providers
  openaiTruncationMode?: OpenAIResponsesProviderOptions["truncation"]
): ProviderOptions {
  // Caller is responsible for enforcing thinking policy before calling this function.
  // agentSession.ts is the canonical enforcement point.
  const effectiveThinking = thinkingLevel;
  // Parse provider from normalized model string
  const [provider, modelName] = normalizeGatewayModel(modelString).split(":", 2);

  log.debug("buildProviderOptions", {
    modelString,
    provider,
    modelName,
    thinkingLevel,
  });

  if (!provider || !modelName) {
    log.debug("buildProviderOptions: No provider or model name found, returning empty");
    return {};
  }

  // Build Anthropic-specific options
  if (provider === "anthropic") {
    const disableBeta = muxProviderOptions?.anthropic?.disableBetaFeatures === true;
    const cacheTtl = disableBeta ? undefined : muxProviderOptions?.anthropic?.cacheTtl;
    const cacheControl = cacheTtl ? { type: "ephemeral" as const, ttl: cacheTtl } : undefined;

    // Opus 4.5+ and Sonnet 4.6 use the effort parameter for reasoning control.
    // Opus 4.6 / Sonnet 4.6 use adaptive thinking (model decides when/how much to think).
    // Opus 4.5 uses enabled thinking with a budgetTokens ceiling.
    const isOpus45 = modelName?.includes("opus-4-5") ?? false;
    const isOpus46 = modelName?.includes("opus-4-6") ?? false;
    const isSonnet46 = modelName?.includes("sonnet-4-6") ?? false;
    const usesAdaptiveThinking = isOpus46 || isSonnet46;

    if (isOpus45 || usesAdaptiveThinking) {
      // xhigh maps to "max" effort; policy clamps Opus 4.5 to "high" max
      const effortLevel = getAnthropicEffort(effectiveThinking);
      const budgetTokens = ANTHROPIC_THINKING_BUDGETS[effectiveThinking];
      // Opus 4.6 / Sonnet 4.6: adaptive thinking when on, disabled when off
      // Opus 4.5: enabled thinking with budgetTokens ceiling (only when not "off")
      const thinking: AnthropicProviderOptions["thinking"] = usesAdaptiveThinking
        ? effectiveThinking === "off"
          ? { type: "disabled" }
          : { type: "adaptive" }
        : budgetTokens > 0
          ? { type: "enabled", budgetTokens }
          : undefined;

      log.debug("buildProviderOptions: Anthropic effort model config", {
        effort: effortLevel,
        thinking,
        thinkingLevel: effectiveThinking,
      });

      return {
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
          ...(thinking && { thinking }),
          ...(cacheControl && { cacheControl }),
          effort: effortLevel,
        },
      };
    }

    // Other Anthropic models: Use thinking parameter with budgetTokens
    const budgetTokens = ANTHROPIC_THINKING_BUDGETS[effectiveThinking];
    log.debug("buildProviderOptions: Anthropic config", {
      budgetTokens,
      thinkingLevel: effectiveThinking,
    });

    const options: ProviderOptions = {
      anthropic: {
        disableParallelToolUse: false, // Always enable concurrent tool execution
        sendReasoning: true, // Include reasoning traces in requests sent to the model
        ...(cacheControl && { cacheControl }),
        // Conditionally add thinking configuration (non-Opus 4.5 models)
        ...(budgetTokens > 0 && {
          thinking: {
            type: "enabled",
            budgetTokens,
          },
        }),
      },
    };
    log.debug("buildProviderOptions: Returning Anthropic options", options);
    return options;
  }

  // Build OpenAI-specific options
  if (provider === "openai") {
    const reasoningEffort = OPENAI_REASONING_EFFORT[effectiveThinking];

    // Extract previousResponseId from last assistant message for persistence
    // IMPORTANT: Only use previousResponseId if:
    // 1. The previous message used the same model (prevents cross-model contamination)
    // 2. That model uses reasoning (reasoning effort is set)
    // 3. The response ID exists
    // 4. The response ID hasn't been invalidated by OpenAI
    let previousResponseId: string | undefined;
    if (messages && messages.length > 0 && reasoningEffort) {
      // Parse current model name (without provider prefix), normalize gateway format if needed
      const currentModelName = normalizeGatewayModel(modelString).split(":")[1];

      // Find last assistant message from the same model
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
          // Check if this message is from the same model
          const msgModel = msg.metadata?.model;
          const msgModelName = msgModel ? normalizeGatewayModel(msgModel).split(":")[1] : undefined;

          if (msgModelName === currentModelName) {
            const metadata = msg.metadata?.providerMetadata;
            if (metadata && "openai" in metadata) {
              const openaiData = metadata.openai as Record<string, unknown> | undefined;
              previousResponseId = openaiData?.responseId as string | undefined;
            }
            if (previousResponseId) {
              // Check if this responseId has been invalidated by OpenAI
              if (lostResponseIds?.(previousResponseId)) {
                log.info("buildProviderOptions: Filtering out lost previousResponseId", {
                  previousResponseId,
                  model: currentModelName,
                });
                previousResponseId = undefined;
              } else {
                log.debug("buildProviderOptions: Found previousResponseId from same model", {
                  previousResponseId,
                  model: currentModelName,
                });
              }
              break;
            }
          } else if (msgModelName) {
            // Found assistant message from different model, stop searching
            log.debug("buildProviderOptions: Skipping previousResponseId - model changed", {
              previousModel: msgModelName,
              currentModel: currentModelName,
            });
            break;
          }
        }
      }
    }

    // Prompt cache key: derive from workspaceId
    // This helps OpenAI route requests to cached prefixes for improved hit rates
    // workspaceId is always passed from AIService.streamMessage for real requests
    const promptCacheKey = workspaceId ? `mux-v1-${workspaceId}` : undefined;

    const serviceTier = muxProviderOptions?.openai?.serviceTier ?? "auto";
    const wireFormat = muxProviderOptions?.openai?.wireFormat ?? "responses";
    const store = muxProviderOptions?.openai?.store;
    const isResponses = wireFormat === "responses";
    const truncationMode = openaiTruncationMode ?? "disabled";
    const shouldSendReasoningSummary = supportsOpenAIReasoningSummary(modelName);

    log.debug("buildProviderOptions: OpenAI config", {
      reasoningEffort,
      shouldSendReasoningSummary,
      thinkingLevel: effectiveThinking,
      previousResponseId,
      promptCacheKey,
      truncation: truncationMode,
      wireFormat,
    });

    const options: ProviderOptions = {
      openai: {
        parallelToolCalls: true, // Always enable concurrent tool execution
        serviceTier,
        ...(store != null && { store }), // ZDR: pass store flag through to OpenAI SDK
        ...(isResponses && {
          // Default to disabled; allow auto truncation for compaction to avoid context errors
          truncation: truncationMode,
          // Stable prompt cache key to improve OpenAI cache hit rates
          // See: https://sdk.vercel.ai/providers/ai-sdk-providers/openai#responses-models
          ...(promptCacheKey && { promptCacheKey }),
        }),
        // Conditionally add reasoning configuration
        ...(reasoningEffort && {
          reasoningEffort,
          ...(isResponses &&
            shouldSendReasoningSummary && {
              reasoningSummary: "detailed", // Enable detailed reasoning summaries when the model supports it
            }),
          ...(isResponses && {
            // Include reasoning encrypted content to preserve reasoning context across conversation steps
            // Required when using reasoning models (gpt-5, o3, o4-mini) with tool calls
            // See: https://sdk.vercel.ai/providers/ai-sdk-providers/openai#responses-models
            include: ["reasoning.encrypted_content"],
          }),
        }),
        // Include previousResponseId for conversation persistence
        // OpenAI uses this to maintain reasoning state across turns
        ...(isResponses && previousResponseId && { previousResponseId }),
      },
    };
    log.info("buildProviderOptions: Returning OpenAI options", options);
    return options;
  }

  // Build Google-specific options
  if (provider === "google") {
    const isGemini3 = modelString.includes("gemini-3");
    let thinkingConfig: GoogleGenerativeAIProviderOptions["thinkingConfig"];

    if (effectiveThinking !== "off") {
      thinkingConfig = {
        includeThoughts: true,
      };

      if (isGemini3) {
        // Policy enforcement already clamped to valid levels for Flash/Pro,
        // so effectiveThinking is guaranteed in the model's allowed set.
        // Flash: off/low/medium/high; Pro: low/high. "xhigh" can't reach here.
        thinkingConfig.thinkingLevel = effectiveThinking as Exclude<
          ThinkingLevel,
          "off" | "xhigh" | "max"
        >;
      } else {
        // Gemini 2.5 uses thinkingBudget
        const budget = GEMINI_THINKING_BUDGETS[effectiveThinking];
        if (budget > 0) {
          thinkingConfig.thinkingBudget = budget;
        }
      }
    }

    const options: ProviderOptions = {
      google: {
        thinkingConfig,
      },
    };
    log.debug("buildProviderOptions: Google options", options);
    return options;
  }

  // Build OpenRouter-specific options
  if (provider === "openrouter") {
    const reasoningEffort = OPENROUTER_REASONING_EFFORT[effectiveThinking];

    log.debug("buildProviderOptions: OpenRouter config", {
      reasoningEffort,
      thinkingLevel: effectiveThinking,
    });

    // Only add reasoning config if thinking is enabled
    if (reasoningEffort) {
      const options: ProviderOptions = {
        openrouter: {
          reasoning: {
            enabled: true,
            effort: reasoningEffort,
            // Don't exclude reasoning content - we want to display it in the UI
            exclude: false,
          },
        },
      };
      log.debug("buildProviderOptions: Returning OpenRouter options", options);
      return options;
    }

    // No reasoning config needed when thinking is off
    log.debug("buildProviderOptions: OpenRouter (thinking off, no provider options)");
    return {};
  }

  // Build xAI-specific options
  if (provider === "xai") {
    const overrides = muxProviderOptions?.xai ?? {};

    const defaultSearchParameters: XaiProviderOptions["searchParameters"] = {
      mode: "auto",
      returnCitations: true,
    };

    const options: ProviderOptions = {
      xai: {
        ...overrides,
        searchParameters: overrides.searchParameters ?? defaultSearchParameters,
      },
    };
    log.debug("buildProviderOptions: Returning xAI options", options);
    return options;
  }

  // No provider-specific options for unsupported providers
  log.debug("buildProviderOptions: Unsupported provider", provider);
  return {};
}

// ---------------------------------------------------------------------------
// Per-request HTTP headers
// ---------------------------------------------------------------------------

/** Header value for Anthropic 1M context beta */
export const ANTHROPIC_1M_CONTEXT_HEADER = "context-1m-2025-08-07";

/**
 * Build per-request HTTP headers for provider-specific features.
 *
 * These flow through streamText({ headers }) to the provider SDK, which merges
 * them with provider-creation-time headers via combineHeaders(). This is the
 * single injection site for features like the Anthropic 1M context beta header,
 * regardless of whether the model is direct or gateway-routed.
 */
export function buildRequestHeaders(
  modelString: string,
  muxProviderOptions?: MuxProviderOptions
): Record<string, string> | undefined {
  const normalized = normalizeGatewayModel(modelString);
  const [provider] = normalized.split(":", 2);

  if (provider !== "anthropic") return undefined;

  // ZDR: skip all Anthropic beta headers when beta features are disabled.
  if (muxProviderOptions?.anthropic?.disableBetaFeatures) return undefined;

  const is1MEnabled =
    ((muxProviderOptions?.anthropic?.use1MContextModels?.includes(normalized) ?? false) ||
      muxProviderOptions?.anthropic?.use1MContext === true) &&
    supports1MContext(normalized);

  if (!is1MEnabled) return undefined;
  return { "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER };
}
