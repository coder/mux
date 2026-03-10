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
import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import type { ThinkingLevel } from "@/common/types/thinking";
import {
  getAnthropicEffort,
  ANTHROPIC_THINKING_BUDGETS,
  GEMINI_THINKING_BUDGETS,
  OPENAI_REASONING_EFFORT,
  OPENROUTER_REASONING_EFFORT,
} from "@/common/types/thinking";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { log } from "@/node/services/log";
import type { MuxMessage } from "@/common/types/message";
import { normalizeToCanonical, supports1MContext } from "./models";

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

type OpenAICompatibleGatewayProviderOptions = Pick<
  OpenAIResponsesProviderOptions,
  "reasoningEffort"
>;

/**
 * Provider-specific options structure for AI SDK
 */
type ProviderOptions =
  | { anthropic: AnthropicProviderOptions }
  | { openai: OpenAIResponsesProviderOptions }
  | { google: GoogleGenerativeAIProviderOptions }
  | { openrouter: OpenRouterReasoningOptions }
  | { xai: XaiProviderOptions }
  | { "github-copilot": OpenAICompatibleGatewayProviderOptions }
  | Record<string, never>; // Empty object for unsupported providers

const OPENAI_REASONING_SUMMARY_UNSUPPORTED_MODELS = new Set<string>([
  // Codex Spark rejects reasoning.summary with:
  // "Unsupported parameter: 'reasoning.summary' ...".
  "gpt-5.3-codex-spark",
]);

function supportsOpenAIReasoningSummary(modelName: string): boolean {
  return !OPENAI_REASONING_SUMMARY_UNSUPPORTED_MODELS.has(modelName);
}

export function resolveProviderOptionsNamespaceKey(
  canonicalProviderName: string,
  routeProvider?: ProviderName
): string {
  const routeDefinition = routeProvider ? PROVIDER_DEFINITIONS[routeProvider] : undefined;
  if (
    !routeProvider ||
    routeProvider === canonicalProviderName ||
    (routeDefinition != null &&
      "passthrough" in routeDefinition &&
      routeDefinition.passthrough === true)
  ) {
    return canonicalProviderName;
  }

  return routeProvider;
}

function createNamespacedProviderOptions<T extends object>(
  namespaceKey: string,
  options: T
): ProviderOptions {
  return { [namespaceKey]: options } as ProviderOptions;
}

function resolveAnthropic1MCapabilityModel(
  modelString: string,
  providersConfig?: ProvidersConfigMap | null
): {
  normalizedModel: string;
  capabilityModel: string;
} {
  const normalizedModel = normalizeToCanonical(modelString);
  return {
    normalizedModel,
    capabilityModel: resolveModelForMetadata(normalizedModel, providersConfig ?? null),
  };
}

function hasAnthropic1MIntentForModel(
  modelString: string,
  capabilityModel: string,
  muxProviderOptions?: MuxProviderOptions
): boolean {
  const anthropicOptions = muxProviderOptions?.anthropic;
  if (!anthropicOptions) {
    return false;
  }

  if (anthropicOptions.use1MContext === true) {
    return true;
  }

  const enabledModels = anthropicOptions.use1MContextModels;
  if (!enabledModels || enabledModels.length === 0) {
    return false;
  }

  const normalizedModel = normalizeToCanonical(modelString);
  const candidateModels = new Set([modelString, normalizedModel, capabilityModel]);
  return enabledModels.some((enabledModel) => candidateModels.has(enabledModel));
}

/**
 * Shared Anthropic 1M eligibility check used by request headers, retries, and compaction.
 *
 * 1M is effectively enabled only when the model supports it, the request expressed
 * Anthropic 1M intent, and beta features have not been disabled.
 */
export function isAnthropic1MEffectivelyEnabled(
  modelString: string,
  muxProviderOptions?: MuxProviderOptions,
  providersConfig?: ProvidersConfigMap | null
): boolean {
  const anthropicOptions = muxProviderOptions?.anthropic;
  if (!anthropicOptions || anthropicOptions.disableBetaFeatures === true) {
    return false;
  }

  const { capabilityModel } = resolveAnthropic1MCapabilityModel(modelString, providersConfig);
  if (!supports1MContext(capabilityModel)) {
    return false;
  }

  return hasAnthropic1MIntentForModel(modelString, capabilityModel, muxProviderOptions);
}

/**
 * Preserve Anthropic 1M intent across routed follow-ups only when the source request
 * had effective 1M enabled and the target model is also eligible.
 */
export function preserveAnthropic1MContextForFollowUp(
  sourceModelString: string,
  targetModelString: string,
  muxProviderOptions?: MuxProviderOptions,
  providersConfig?: ProvidersConfigMap | null
): MuxProviderOptions | undefined {
  if (!muxProviderOptions) {
    return undefined;
  }

  if (!isAnthropic1MEffectivelyEnabled(sourceModelString, muxProviderOptions, providersConfig)) {
    return muxProviderOptions;
  }

  const anthropicOptions = muxProviderOptions.anthropic;
  if (!anthropicOptions) {
    return muxProviderOptions;
  }

  const { capabilityModel } = resolveAnthropic1MCapabilityModel(targetModelString, providersConfig);
  if (!supports1MContext(capabilityModel)) {
    return muxProviderOptions;
  }

  return {
    ...muxProviderOptions,
    anthropic: {
      ...anthropicOptions,
      use1MContext: true,
    },
  };
}

/**
 * Build provider-specific options for AI SDK based on thinking level
 *
 * This function configures provider-specific options for supported providers:
 * 1. Enable reasoning traces (transparency into model's thought process)
 * 2. Set reasoning level (control depth of reasoning based on task complexity)
 * 3. Enable parallel tool calls (allow concurrent tool execution)
 * 4. Keep provider-specific request knobs consistent with Mux's explicit history model
 *
 * @param modelString - Full model string (e.g., "anthropic:claude-opus-4-1")
 * @param thinkingLevel - Unified thinking level (must be pre-clamped via enforceThinkingPolicy)
 * @param messages - Conversation history being sent to the provider
 * @param _lostResponseIds - Reserved for OpenAI response-state recovery filtering
 * @param muxProviderOptions - Optional provider overrides from config
 * @param workspaceId - Optional for non-OpenAI providers
 * @param openaiTruncationMode - Optional truncation mode for OpenAI responses (auto/disabled)
 * @param providersConfig - Optional providers config for mapped model capability detection
 * @param routeProvider - Optional route provider (gateway/direct) for SDK format selection
 * @returns Provider options object for AI SDK
 */
export function buildProviderOptions(
  modelString: string,
  thinkingLevel: ThinkingLevel,
  messages?: MuxMessage[],
  _lostResponseIds?: (id: string) => boolean,
  muxProviderOptions?: MuxProviderOptions,
  workspaceId?: string, // Optional for non-OpenAI providers
  openaiTruncationMode?: OpenAIResponsesProviderOptions["truncation"],
  providersConfig?: ProvidersConfigMap | null,
  routeProvider?: ProviderName
): ProviderOptions {
  // Caller is responsible for enforcing thinking policy before calling this function.
  // agentSession.ts is the canonical enforcement point.
  const effectiveThinking = thinkingLevel;
  // Parse origin from normalized model string
  const normalizedModel = normalizeToCanonical(modelString);
  const [origin, modelName] = normalizedModel.split(":", 2);

  if (!origin || !modelName) {
    log.debug("buildProviderOptions: No origin or model name found, returning empty");
    return {};
  }

  const providerOptionsNamespaceKey = resolveProviderOptionsNamespaceKey(origin, routeProvider);

  // SDK payload-family selection: passthrough gateways use origin payloads,
  // while transforming gateways use the route provider's payload schema.
  const formatProvider =
    providerOptionsNamespaceKey === origin ? origin : (routeProvider ?? origin);

  // Resolve aliases to their base model for capability detection while keeping
  // the original modelString for provider routing and metadata lookups.
  const capabilityModel = resolveModelForMetadata(normalizedModel, providersConfig ?? null);
  const [, resolvedCapabilityModelName] = capabilityModel.split(":", 2);
  const capModelName = resolvedCapabilityModelName || modelName;

  log.debug("buildProviderOptions", {
    modelString,
    origin,
    routeProvider,
    providerOptionsNamespaceKey,
    formatProvider,
    modelName,
    capabilityModel,
    capModelName,
    thinkingLevel,
  });

  // Build Anthropic-specific options
  if (formatProvider === "anthropic") {
    const disableBeta = muxProviderOptions?.anthropic?.disableBetaFeatures === true;
    const cacheTtl = disableBeta ? undefined : muxProviderOptions?.anthropic?.cacheTtl;
    const cacheControl = cacheTtl ? { type: "ephemeral" as const, ttl: cacheTtl } : undefined;

    // Opus 4.5+ and Sonnet 4.6 use the effort parameter for reasoning control.
    // Opus 4.6 / Sonnet 4.6 use adaptive thinking (model decides when/how much to think).
    // Opus 4.5 uses enabled thinking with a budgetTokens ceiling.
    const isOpus45 = capModelName?.includes("opus-4-5") ?? false;
    const isOpus46 = capModelName?.includes("opus-4-6") ?? false;
    const isSonnet46 = capModelName?.includes("sonnet-4-6") ?? false;
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

      return createNamespacedProviderOptions(providerOptionsNamespaceKey, {
        disableParallelToolUse: false,
        sendReasoning: true,
        ...(thinking && { thinking }),
        ...(cacheControl && { cacheControl }),
        effort: effortLevel,
      });
    }

    // Other Anthropic models: Use thinking parameter with budgetTokens
    const budgetTokens = ANTHROPIC_THINKING_BUDGETS[effectiveThinking];
    log.debug("buildProviderOptions: Anthropic config", {
      budgetTokens,
      thinkingLevel: effectiveThinking,
    });

    const options = createNamespacedProviderOptions(providerOptionsNamespaceKey, {
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
    });
    log.debug("buildProviderOptions: Returning Anthropic options", options);
    return options;
  }

  // Build OpenAI-specific options
  if (formatProvider === "openai") {
    const reasoningEffort = OPENAI_REASONING_EFFORT[effectiveThinking];

    // Mux always sends the latest conversation history explicitly. OpenAI's
    // previous_response_id is an alternative state-management path, not an additive one.
    // Chaining it on top of explicit history double-counts prior turns and caused GPT-5.4
    // requests to hit context_exceeded far below the documented native window.

    // Prompt cache key: derive from workspaceId
    // This helps OpenAI route requests to cached prefixes for improved hit rates
    // workspaceId is always passed from AIService.streamMessage for real requests
    const promptCacheKey = workspaceId ? `mux-v1-${workspaceId}` : undefined;

    const serviceTier = muxProviderOptions?.openai?.serviceTier ?? "auto";
    const wireFormat = muxProviderOptions?.openai?.wireFormat ?? "responses";
    const store = muxProviderOptions?.openai?.store;
    const isResponses = wireFormat === "responses";
    const truncationMode = openaiTruncationMode ?? "disabled";
    const shouldSendReasoningSummary = supportsOpenAIReasoningSummary(capModelName);

    log.debug("buildProviderOptions: OpenAI config", {
      reasoningEffort,
      shouldSendReasoningSummary,
      thinkingLevel: effectiveThinking,
      historyMessages: messages?.length ?? 0,
      promptCacheKey,
      truncation: truncationMode,
      wireFormat,
    });

    const options = createNamespacedProviderOptions(providerOptionsNamespaceKey, {
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
    });
    log.info("buildProviderOptions: Returning OpenAI options", options);
    return options;
  }

  // Build Google-specific options
  if (formatProvider === "google") {
    const isGemini3 = capModelName.includes("gemini-3");
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

    const options = createNamespacedProviderOptions(providerOptionsNamespaceKey, {
      thinkingConfig,
    });
    log.debug("buildProviderOptions: Google options", options);
    return options;
  }

  // Build OpenRouter-specific options
  if (formatProvider === "openrouter") {
    const reasoningEffort = OPENROUTER_REASONING_EFFORT[effectiveThinking];

    log.debug("buildProviderOptions: OpenRouter config", {
      reasoningEffort,
      thinkingLevel: effectiveThinking,
    });

    // Only add reasoning config if thinking is enabled
    if (reasoningEffort) {
      const options = createNamespacedProviderOptions(providerOptionsNamespaceKey, {
        reasoning: {
          enabled: true,
          effort: reasoningEffort,
          // Don't exclude reasoning content - we want to display it in the UI
          exclude: false,
        },
      });
      log.debug("buildProviderOptions: Returning OpenRouter options", options);
      return options;
    }

    // No reasoning config needed when thinking is off
    log.debug("buildProviderOptions: OpenRouter (thinking off, no provider options)");
    return {};
  }

  // Build xAI-specific options
  if (formatProvider === "xai") {
    const overrides = muxProviderOptions?.xai ?? {};

    const defaultSearchParameters: XaiProviderOptions["searchParameters"] = {
      mode: "auto",
      returnCitations: true,
    };

    const options = createNamespacedProviderOptions(providerOptionsNamespaceKey, {
      ...overrides,
      searchParameters: overrides.searchParameters ?? defaultSearchParameters,
    });
    log.debug("buildProviderOptions: Returning xAI options", options);
    return options;
  }

  if (origin === "openai" && formatProvider !== origin) {
    const reasoningEffort = OPENAI_REASONING_EFFORT[effectiveThinking];
    if (!reasoningEffort) {
      log.debug(
        "buildProviderOptions: OpenAI-compatible gateway (thinking off, no provider options)",
        {
          formatProvider,
          origin,
          routeProvider,
          providerOptionsNamespaceKey,
        }
      );
      return {};
    }

    const options = createNamespacedProviderOptions(providerOptionsNamespaceKey, {
      reasoningEffort,
    });
    log.debug("buildProviderOptions: Returning OpenAI-compatible gateway options", options);
    return options;
  }

  // No provider-specific options for unsupported providers
  log.debug("buildProviderOptions: Unsupported format provider", {
    formatProvider,
    origin,
    routeProvider,
    providerOptionsNamespaceKey,
  });
  return {};
}

// ---------------------------------------------------------------------------
// Per-request HTTP headers
// ---------------------------------------------------------------------------

/** Header value for Anthropic 1M context beta */
export const ANTHROPIC_1M_CONTEXT_HEADER = "context-1m-2025-08-07";

/** HTTP header sent on AI requests for workspace-level observability. */
export const MUX_WORKSPACE_ID_HEADER = "X-Mux-Workspace-Id";

const HTTP_HEADER_VALUE_SAFE_PATTERN = /^[\t\x20-\x7E\x80-\xFF]+$/;

/**
 * Encode workspace IDs that contain non-header-safe bytes.
 *
 * Legacy workspace IDs may include non-Latin-1 characters (e.g., emoji from
 * project/workspace names). Fetch rejects such header values, which would abort
 * the request before it reaches the provider. We keep safe IDs unchanged for
 * readability and encode unsafe ones into a stable URL-safe base64 form.
 */
function toWorkspaceHeaderValue(workspaceId: string): string {
  if (HTTP_HEADER_VALUE_SAFE_PATTERN.test(workspaceId)) {
    return workspaceId;
  }

  return `b64:${Buffer.from(workspaceId, "utf8").toString("base64url")}`;
}

/**
 * Build per-request HTTP headers for provider-specific features.
 *
 * These flow through streamText({ headers }) to the provider SDK, which merges
 * them with provider-creation-time headers via combineHeaders(). This is the
 * single injection site for headers like the workspace correlation header and
 * Anthropic's 1M context beta header, regardless of direct vs gateway routing.
 */
export function buildRequestHeaders(
  modelString: string,
  muxProviderOptions?: MuxProviderOptions,
  workspaceId?: string,
  providersConfig?: ProvidersConfigMap | null,
  routeProvider?: ProviderName
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  if (workspaceId != null) {
    headers[MUX_WORKSPACE_ID_HEADER] = toWorkspaceHeaderValue(workspaceId);
  }

  const normalized = normalizeToCanonical(modelString);
  const [origin] = normalized.split(":", 2);

  // 1M context header — only when origin supports it AND route is passthrough (or direct)
  const routePassesHeaders =
    origin != null && resolveProviderOptionsNamespaceKey(origin, routeProvider) === origin;

  if (
    origin === "anthropic" &&
    routePassesHeaders &&
    isAnthropic1MEffectivelyEnabled(modelString, muxProviderOptions, providersConfig)
  ) {
    headers["anthropic-beta"] = ANTHROPIC_1M_CONTEXT_HEADER;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}
