/**
 * Provider options builder for AI SDK
 *
 * Converts unified thinking levels to provider-specific options
 */

import type { AnthropicProviderOptions } from "@ai-sdk/anthropic";
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import type { XaiProviderOptions } from "@ai-sdk/xai";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import type { ThinkingLevel } from "@/common/types/thinking";
import {
  ANTHROPIC_THINKING_BUDGETS,
  GEMINI_THINKING_BUDGETS,
  OPENAI_REASONING_EFFORT,
  OPENROUTER_REASONING_EFFORT,
} from "@/common/types/thinking";
import { log } from "@/node/services/log";
import type { MuxMessage } from "@/common/types/message";
import { enforceThinkingPolicy } from "@/browser/utils/thinking/policy";

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
 * @param thinkingLevel - Unified thinking level
 * @param messages - Conversation history to extract previousResponseId from
 * @param lostResponseIds - Optional callback to check if a responseId has been invalidated by OpenAI
 * @returns Provider options object for AI SDK
 */
export function buildProviderOptions(
  modelString: string,
  thinkingLevel: ThinkingLevel,
  messages?: MuxMessage[],
  lostResponseIds?: (id: string) => boolean,
  muxProviderOptions?: MuxProviderOptions
): ProviderOptions {
  // Always clamp to the model's supported thinking policy (e.g., gpt-5-pro = HIGH only)
  const effectiveThinking = enforceThinkingPolicy(modelString, thinkingLevel);
  // Parse provider from model string
  const [provider] = modelString.split(":");

  log.debug("buildProviderOptions", {
    modelString,
    provider,
    thinkingLevel,
  });

  if (!provider) {
    log.debug("buildProviderOptions: No provider found, returning empty");
    return {};
  }

  // Build Anthropic-specific options
  if (provider === "anthropic") {
    const budgetTokens = ANTHROPIC_THINKING_BUDGETS[effectiveThinking];
    log.debug("buildProviderOptions: Anthropic config", {
      budgetTokens,
      thinkingLevel: effectiveThinking,
    });

    const options: ProviderOptions = {
      anthropic: {
        disableParallelToolUse: false, // Always enable concurrent tool execution
        sendReasoning: true, // Include reasoning traces in requests sent to the model
        // Conditionally add thinking configuration
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
      // Parse current model name (without provider prefix)
      const [, currentModelName] = modelString.split(":");

      // Find last assistant message from the same model
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
          // Check if this message is from the same model
          const msgModel = msg.metadata?.model;
          const [, msgModelName] = msgModel?.split(":") ?? [];

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

    log.debug("buildProviderOptions: OpenAI config", {
      reasoningEffort,
      thinkingLevel: effectiveThinking,
      previousResponseId,
    });

    const options: ProviderOptions = {
      openai: {
        parallelToolCalls: true, // Always enable concurrent tool execution
        // TODO: allow this to be configured
        serviceTier: "auto", // Use "auto" to automatically select the best service tier
        truncation: "auto", // Automatically truncate conversation to fit context window
        // Conditionally add reasoning configuration
        ...(reasoningEffort && {
          reasoningEffort,
          reasoningSummary: "detailed", // Enable detailed reasoning summaries
          // Include reasoning encrypted content to preserve reasoning context across conversation steps
          // Required when using reasoning models (gpt-5, o3, o4-mini) with tool calls
          // See: https://sdk.vercel.ai/providers/ai-sdk-providers/openai#responses-models
          include: ["reasoning.encrypted_content"],
        }),
        // Include previousResponseId for conversation persistence
        // OpenAI uses this to maintain reasoning state across turns
        ...(previousResponseId && { previousResponseId }),
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
        // Gemini 3 uses thinkingLevel (low/high)
        thinkingConfig.thinkingLevel = effectiveThinking === "medium" ? "low" : effectiveThinking;
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
