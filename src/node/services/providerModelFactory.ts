import assert from "node:assert";
import type { XaiProviderOptions } from "@ai-sdk/xai";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { LanguageModel } from "ai";
import type { ThinkingLevel } from "@/common/types/thinking";
import { Ok, Err } from "@/common/types/result";
import type { Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import {
  PROVIDER_REGISTRY,
  PROVIDER_DEFINITIONS,
  MUX_GATEWAY_SUPPORTED_PROVIDERS,
  type ProviderName,
} from "@/common/constants/providers";
import {
  CODEX_ENDPOINT,
  isCodexOauthAllowedModelId,
  isCodexOauthRequiredModelId,
} from "@/common/constants/codexOAuth";
import { parseCodexOauthAuth } from "@/node/utils/codexOauthAuth";
import type { Config, ProviderConfig } from "@/node/config";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { isProviderDisabledInConfig } from "@/common/utils/providers/isProviderDisabled";
import type { PolicyService } from "@/node/services/policyService";
import type { ProviderService } from "@/node/services/providerService";
import type { CodexOauthService } from "@/node/services/codexOauthService";
import { normalizeGatewayModel } from "@/common/utils/ai/models";
import type { AnthropicCacheTtl } from "@/common/utils/ai/cacheStrategy";
import { MUX_APP_ATTRIBUTION_TITLE, MUX_APP_ATTRIBUTION_URL } from "@/constants/appAttribution";
import { resolveProviderCredentials } from "@/node/utils/providerRequirements";
import {
  normalizeGatewayStreamUsage,
  normalizeGatewayGenerateResult,
} from "@/node/utils/gatewayStreamNormalization";
import { EnvHttpProxyAgent, type Dispatcher } from "undici";
import packageJson from "../../../package.json";

// ---------------------------------------------------------------------------
// Undici agent with unlimited timeouts for AI streaming requests.
// Safe because users control cancellation via AbortSignal from the UI.
// Uses EnvHttpProxyAgent to automatically respect HTTP_PROXY, HTTPS_PROXY,
// and NO_PROXY environment variables for debugging/corporate network support.
// ---------------------------------------------------------------------------

const unlimitedTimeoutAgent = new EnvHttpProxyAgent({
  bodyTimeout: 0, // No timeout - prevents BodyTimeoutError on long reasoning pauses
  headersTimeout: 0, // No timeout for headers
});

// Extend RequestInit with undici-specific dispatcher property (Node.js only)
type RequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

const muxVersionFromEnv = (() => {
  const value = process.env.MUX_VERSION?.trim();
  return value && value.length > 0 ? value : undefined;
})();

const muxVersionFromPackageJson = (() => {
  if (typeof packageJson.version !== "string") {
    return undefined;
  }
  const value = packageJson.version.trim();
  return value.length > 0 ? value : undefined;
})();

// Stable default User-Agent for AI provider requests.
// Prefer MUX_VERSION when provided by the runtime; otherwise fall back to package.json.
// This keeps attribution consistent across all provider SDKs that use fetch.
export const MUX_AI_PROVIDER_USER_AGENT = `mux/${
  muxVersionFromEnv ?? muxVersionFromPackageJson ?? "dev"
}`;

assert(
  MUX_AI_PROVIDER_USER_AGENT.length > "mux/".length,
  "MUX_AI_PROVIDER_USER_AGENT must include a non-empty version"
);

/**
 * Resolve the header source for provider fetch calls.
 *
 * When fetch is called with a Request object, that Request may already carry
 * auth/content headers. Preserve those unless init.headers is explicitly provided,
 * matching fetch override semantics.
 */
export function resolveAIProviderHeaderSource(
  input: RequestInfo | URL,
  init?: RequestInit
): HeadersInit | undefined {
  if (init?.headers != null) {
    return init.headers;
  }

  return input instanceof Request ? input.headers : undefined;
}

/**
 * Build request headers for provider fetch calls, ensuring a User-Agent is always present.
 * Exported for testing.
 */
export function buildAIProviderRequestHeaders(existingHeaders: HeadersInit | undefined): Headers {
  const headers = new Headers(existingHeaders);

  // Respect user/provider overrides (header names are case-insensitive).
  if (!headers.has("user-agent")) {
    headers.set("User-Agent", MUX_AI_PROVIDER_USER_AGENT);
  }

  return headers;
}

/**
 * Default fetch function with unlimited timeouts for AI streaming.
 * Uses undici Agent to remove artificial timeout limits while still
 * respecting user cancellation via AbortSignal.
 *
 * Note: If users provide custom fetch in providers.jsonc, they are
 * responsible for configuring timeouts appropriately. Custom fetch
 * implementations using undici should set bodyTimeout: 0 and
 * headersTimeout: 0 to prevent BodyTimeoutError on long-running
 * reasoning models.
 */
const defaultFetchWithUnlimitedTimeout = (async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const headerSource = resolveAIProviderHeaderSource(input, init);
  const headers = buildAIProviderRequestHeaders(headerSource);

  // dispatcher is a Node.js undici-specific property for custom HTTP agents
  const requestInit: RequestInitWithDispatcher = {
    ...(init ?? {}),
    headers,
    dispatcher: unlimitedTimeoutAgent,
  };
  return fetch(input, requestInit);
}) as typeof fetch;

type FetchWithBunExtensions = typeof fetch & {
  preconnect?: typeof fetch extends { preconnect: infer P } ? P : unknown;
  certificate?: typeof fetch extends { certificate: infer C } ? C : unknown;
};

const globalFetchWithExtras = fetch as FetchWithBunExtensions;
const defaultFetchWithExtras = defaultFetchWithUnlimitedTimeout as FetchWithBunExtensions;

if (typeof globalFetchWithExtras.preconnect === "function") {
  defaultFetchWithExtras.preconnect = globalFetchWithExtras.preconnect.bind(globalFetchWithExtras);
}

if (typeof globalFetchWithExtras.certificate === "function") {
  defaultFetchWithExtras.certificate =
    globalFetchWithExtras.certificate.bind(globalFetchWithExtras);
}

// ---------------------------------------------------------------------------
// Fetch wrappers
// ---------------------------------------------------------------------------

function mergeAnthropicCacheControl(
  existing: unknown,
  cacheTtl?: AnthropicCacheTtl | null
): Record<string, string> {
  const merged: Record<string, string> = { type: "ephemeral" };

  if (typeof existing === "object" && existing !== null) {
    const existingRecord = existing as Record<string, unknown>;
    if (typeof existingRecord.type === "string") {
      merged.type = existingRecord.type;
    }
    if (typeof existingRecord.ttl === "string") {
      merged.ttl = existingRecord.ttl;
    }
  }

  if (cacheTtl) {
    merged.ttl = cacheTtl;
  }

  return merged;
}

/**
 * Wrap fetch to inject Anthropic cache_control directly into the request body.
 * The AI SDK's providerOptions.anthropic.cacheControl doesn't get translated
 * to raw cache_control for tools or message content parts, so we inject it
 * at the HTTP level.
 *
 * Injects cache_control on:
 * 1. Last tool (caches all tool definitions)
 * 2. Last message's last content part (caches entire conversation)
 */
function wrapFetchWithAnthropicCacheControl(
  baseFetch: typeof fetch,
  cacheTtl?: AnthropicCacheTtl | null
): typeof fetch {
  const cachingFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    // Only modify POST requests with JSON body
    if (init?.method?.toUpperCase() !== "POST" || typeof init?.body !== "string") {
      return baseFetch(input, init);
    }

    try {
      const json = JSON.parse(init.body) as Record<string, unknown>;

      // Inject cache_control on the last tool if tools array exists.
      // If the SDK already populated cache_control, preserve it but override ttl
      // when a higher-level cacheTtl is configured.
      if (Array.isArray(json.tools) && json.tools.length > 0) {
        const lastTool = json.tools[json.tools.length - 1] as Record<string, unknown>;
        lastTool.cache_control = mergeAnthropicCacheControl(lastTool.cache_control, cacheTtl);
      }

      // Inject cache_control on last message's last content part
      // This caches the entire conversation
      // Handle both formats:
      // - Direct Anthropic provider: json.messages (Anthropic API format)
      // - Gateway provider: json.prompt (AI SDK internal format)
      const messages = Array.isArray(json.messages)
        ? json.messages
        : Array.isArray(json.prompt)
          ? json.prompt
          : null;

      if (messages && messages.length >= 1) {
        const lastMsg = messages[messages.length - 1] as Record<string, unknown>;

        // For gateway: add providerOptions.anthropic.cacheControl at message level
        // (gateway validates schema strictly, doesn't allow raw cache_control on messages)
        if (Array.isArray(json.prompt)) {
          const providerOpts = (lastMsg.providerOptions ?? {}) as Record<string, unknown>;
          const anthropicOpts = (providerOpts.anthropic ?? {}) as Record<string, unknown>;
          anthropicOpts.cacheControl = mergeAnthropicCacheControl(
            anthropicOpts.cacheControl,
            cacheTtl
          );
          providerOpts.anthropic = anthropicOpts;
          lastMsg.providerOptions = providerOpts;
        }

        // For direct Anthropic: add cache_control to last content part
        const content = lastMsg.content;
        if (Array.isArray(content) && content.length > 0) {
          const lastPart = content[content.length - 1] as Record<string, unknown>;
          lastPart.cache_control = mergeAnthropicCacheControl(lastPart.cache_control, cacheTtl);
        }
      }

      // Update body with modified JSON
      const newBody = JSON.stringify(json);
      const headers = new Headers(init?.headers);
      headers.delete("content-length"); // Body size changed
      return baseFetch(input, { ...init, headers, body: newBody });
    } catch {
      // If parsing fails, pass through unchanged
      return baseFetch(input, init);
    }
  };

  return Object.assign(cachingFetch, baseFetch) as typeof fetch;
}

/**
 * Wrap fetch so any mux-gateway 401 response clears local credentials (best-effort).
 *
 * This ensures the UI immediately reflects that the user has been logged out
 * when the gateway session expires.
 */
function wrapFetchWithMuxGatewayAutoLogout(
  baseFetch: typeof fetch,
  providerService: ProviderService
): typeof fetch {
  const wrappedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const response = await baseFetch(input, init);

    if (response.status === 401) {
      try {
        providerService.setConfig("mux-gateway", ["couponCode"], "");
        providerService.setConfig("mux-gateway", ["voucher"], "");
      } catch {
        // Ignore failures clearing local credentials
      }
    }

    return response;
  };

  return Object.assign(wrappedFetch, baseFetch) as typeof fetch;
}

/**
 * Get fetch function for provider - use custom if provided, otherwise unlimited timeout default
 */
function getProviderFetch(providerConfig: ProviderConfig): typeof fetch {
  return typeof providerConfig.fetch === "function"
    ? (providerConfig.fetch as typeof fetch)
    : defaultFetchWithUnlimitedTimeout;
}

// ---------------------------------------------------------------------------
// Exported helpers (re-exported from aiService.ts for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Normalize Anthropic base URL to ensure it ends with /v1 suffix.
 *
 * The Anthropic SDK expects baseURL to include /v1 (default: https://api.anthropic.com/v1).
 * Many users configure base URLs without the /v1 suffix, which causes API calls to fail.
 * This function automatically appends /v1 if missing.
 *
 * @param baseURL - The base URL to normalize (may or may not have /v1)
 * @returns The base URL with /v1 suffix
 */
export function normalizeAnthropicBaseURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, ""); // Remove trailing slashes
  if (trimmed.endsWith("/v1")) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

// Canonical definition lives in providerOptions; import for local use + re-export for backward compat.
import { ANTHROPIC_1M_CONTEXT_HEADER } from "@/common/utils/ai/providerOptions";
import { getErrorMessage } from "@/common/utils/errors";
export { ANTHROPIC_1M_CONTEXT_HEADER };

/**
 * Build headers for Anthropic provider, optionally including the 1M context beta header.
 * Exported for testing.
 */
export function buildAnthropicHeaders(
  existingHeaders: Record<string, string> | undefined,
  use1MContext: boolean | undefined
): Record<string, string> | undefined {
  if (!use1MContext) {
    return existingHeaders;
  }
  if (existingHeaders) {
    return { ...existingHeaders, "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER };
  }
  return { "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER };
}

/**
 * Build app attribution headers used by OpenRouter (and other compatible platforms).
 *
 * Attribution docs:
 * - OpenRouter: https://openrouter.ai/docs/app-attribution
 * - Vercel AI Gateway: https://vercel.com/docs/ai-gateway/app-attribution
 *
 * Exported for testing.
 */
export function buildAppAttributionHeaders(
  existingHeaders: Record<string, string> | undefined
): Record<string, string> {
  // Clone to avoid mutating caller-provided objects.
  const headers: Record<string, string> = existingHeaders ? { ...existingHeaders } : {};

  // Header names are case-insensitive. Preserve user-provided values by never overwriting.
  const existingLowercaseKeys = new Set(Object.keys(headers).map((key) => key.toLowerCase()));

  if (!existingLowercaseKeys.has("http-referer")) {
    headers["HTTP-Referer"] = MUX_APP_ATTRIBUTION_URL;
  }

  if (!existingLowercaseKeys.has("x-title")) {
    headers["X-Title"] = MUX_APP_ATTRIBUTION_TITLE;
  }

  return headers;
}

/**
 * Preload AI SDK provider modules to avoid race conditions in concurrent test environments.
 * This function loads @ai-sdk/anthropic, @ai-sdk/openai, and ollama-ai-provider-v2 eagerly
 * so that subsequent dynamic imports in createModel() hit the module cache instead of racing.
 *
 * In production, providers are lazy-loaded on first use to optimize startup time.
 * In tests, we preload them once during setup to ensure reliable concurrent execution.
 */
export async function preloadAISDKProviders(): Promise<void> {
  // Preload providers to ensure they're in the module cache before concurrent tests run
  await Promise.all(Object.values(PROVIDER_REGISTRY).map((importFn) => importFn()));
}

/**
 * Parse provider and model ID from model string.
 * Handles model IDs with colons (e.g., "ollama:gpt-oss:20b").
 * Only splits on the first colon to support Ollama model naming convention.
 *
 * @param modelString - Model string in format "provider:model-id"
 * @returns Tuple of [providerName, modelId]
 * @example
 * parseModelString("anthropic:claude-opus-4") // ["anthropic", "claude-opus-4"]
 * parseModelString("ollama:gpt-oss:20b") // ["ollama", "gpt-oss:20b"]
 */
export function parseModelString(modelString: string): [string, string] {
  const colonIndex = modelString.indexOf(":");
  const providerName = colonIndex !== -1 ? modelString.slice(0, colonIndex) : modelString;
  const modelId = colonIndex !== -1 ? modelString.slice(colonIndex + 1) : "";
  return [providerName, modelId];
}

function parseAnthropicCacheTtl(value: unknown): AnthropicCacheTtl | undefined {
  if (value === "5m" || value === "1h") {
    return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Model cost tracking
// ---------------------------------------------------------------------------

const MUX_MODEL_COSTS_INCLUDED = Symbol("mux:modelCostsIncluded");

type LanguageModelWithMuxCostsIncluded = LanguageModel & {
  [MUX_MODEL_COSTS_INCLUDED]?: true;
};

function markModelCostsIncluded(model: LanguageModel): void {
  (model as LanguageModelWithMuxCostsIncluded)[MUX_MODEL_COSTS_INCLUDED] = true;
}

export function modelCostsIncluded(model: LanguageModel): boolean {
  return (model as LanguageModelWithMuxCostsIncluded)[MUX_MODEL_COSTS_INCLUDED] === true;
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

/**
 * Extract text from AI SDK message content.
 * Content may be a plain string or a structured array like [{type:"text", text:"..."}].
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return (content as unknown[])
      .filter(
        (part): part is { type: string; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
      )
      .map((part) => part.text)
      .join("")
      .trim();
  }
  return "";
}

// ---------------------------------------------------------------------------
// ProviderModelFactory
// ---------------------------------------------------------------------------

/**
 * Factory responsible for creating AI SDK LanguageModel instances from model strings.
 *
 * Extracted from AIService to isolate provider/model construction logic from the
 * streaming and orchestration concerns that AIService owns.
 */
export class ProviderModelFactory {
  private readonly config: Config;
  private readonly providerService: ProviderService;
  private readonly policyService?: PolicyService;
  codexOauthService?: CodexOauthService;

  constructor(
    config: Config,
    providerService: ProviderService,
    policyService?: PolicyService,
    codexOauthService?: CodexOauthService
  ) {
    this.config = config;
    this.providerService = providerService;
    this.policyService = policyService;
    this.codexOauthService = codexOauthService;
  }

  /**
   * Create an AI SDK model from a model string (e.g., "anthropic:claude-opus-4-1")
   *
   * IMPORTANT: We ONLY use providers.jsonc as the single source of truth for provider configuration.
   * We DO NOT use environment variables or default constructors that might read them.
   * This ensures consistent, predictable configuration management.
   *
   * Provider configuration from providers.jsonc is passed verbatim to the provider
   * constructor, ensuring automatic parity with Vercel AI SDK - any configuration options
   * supported by the provider will work without modification.
   */
  async createModel(
    modelString: string,
    muxProviderOptions?: MuxProviderOptions
  ): Promise<Result<LanguageModel, SendMessageError>> {
    try {
      // Gateway routing is resolved here so every caller gets correct behavior
      // automatically. resolveGatewayModelString is idempotent — already-resolved
      // strings (e.g. "mux-gateway:anthropic/model") pass through unchanged.
      const explicitlyRequestedGateway = modelString.trim().startsWith("mux-gateway:");
      modelString = this.resolveGatewayModelString(
        modelString,
        undefined,
        explicitlyRequestedGateway
      );

      // Parse model string (format: "provider:model-id")
      const [providerName, modelId] = parseModelString(modelString);

      if (!providerName || !modelId) {
        return Err({
          type: "invalid_model_string",
          message: `Invalid model string format: "${modelString}". Expected "provider:model-id"`,
        });
      }

      // Check if provider is supported (prevents silent failures when adding to PROVIDER_REGISTRY
      // but forgetting to implement handler below)
      if (!(providerName in PROVIDER_REGISTRY)) {
        return Err({
          type: "provider_not_supported",
          provider: providerName,
        });
      }

      if (this.policyService?.isEnforced()) {
        const provider = providerName as ProviderName;
        if (!this.policyService.isProviderAllowed(provider)) {
          return Err({
            type: "policy_denied",
            message: `Provider ${providerName} is not allowed by policy`,
          });
        }

        if (!this.policyService.isModelAllowed(provider, modelId)) {
          return Err({
            type: "policy_denied",
            message: `Model ${providerName}:${modelId} is not allowed by policy`,
          });
        }
      }

      // Load providers configuration - the ONLY source of truth
      const providersConfig = this.config.loadProvidersConfig() ?? {};

      // Backend config is authoritative for Anthropic prompt cache TTL on any
      // Anthropic-routed model (direct Anthropic, mux-gateway:anthropic/*,
      // openrouter:anthropic/*). We still allow request-level values when config
      // is unset for backward compatibility with older clients.
      const configAnthropicCacheTtl = parseAnthropicCacheTtl(providersConfig.anthropic?.cacheTtl);
      const isAnthropicRoutedModel =
        providerName === "anthropic" || modelId.startsWith("anthropic/");
      if (isAnthropicRoutedModel && configAnthropicCacheTtl && muxProviderOptions) {
        muxProviderOptions.anthropic = {
          ...(muxProviderOptions.anthropic ?? {}),
          cacheTtl: configAnthropicCacheTtl,
        };
      }
      const effectiveAnthropicCacheTtl =
        muxProviderOptions?.anthropic?.cacheTtl ?? configAnthropicCacheTtl;

      let providerConfig = providersConfig[providerName] ?? {};

      // Providers can be disabled in providers.jsonc without deleting credentials.
      if (
        providerName !== "mux-gateway" &&
        isProviderDisabledInConfig(providerConfig as { enabled?: unknown })
      ) {
        return Err({ type: "provider_disabled", provider: providerName });
      }

      // Map baseUrl to baseURL if present (SDK expects baseURL)
      const { baseUrl, ...configWithoutBaseUrl } = providerConfig;
      providerConfig = baseUrl
        ? { ...configWithoutBaseUrl, baseURL: baseUrl }
        : configWithoutBaseUrl;

      // Policy: force provider base URL (if configured).
      const forcedBaseUrl = this.policyService?.isEnforced()
        ? this.policyService.getForcedBaseUrl(providerName as ProviderName)
        : undefined;
      if (forcedBaseUrl) {
        providerConfig = { ...providerConfig, baseURL: forcedBaseUrl };
      }

      // Inject app attribution headers (used by OpenRouter and other compatible platforms).
      // We never overwrite user-provided values (case-insensitive header matching).
      providerConfig = {
        ...providerConfig,
        headers: buildAppAttributionHeaders(providerConfig.headers),
      };

      // Handle Anthropic provider
      if (providerName === "anthropic") {
        // Resolve credentials from config + env (single source of truth)
        const creds = resolveProviderCredentials("anthropic", providerConfig);
        if (!creds.isConfigured) {
          return Err({ type: "api_key_not_found", provider: providerName });
        }

        // Build config with resolved credentials
        const configWithApiKey = creds.apiKey
          ? { ...providerConfig, apiKey: creds.apiKey }
          : providerConfig;

        // Normalize base URL to ensure /v1 suffix (SDK expects it)
        const effectiveBaseURL = configWithApiKey.baseURL ?? creds.baseUrl?.trim();
        const normalizedConfig = effectiveBaseURL
          ? { ...configWithApiKey, baseURL: normalizeAnthropicBaseURL(effectiveBaseURL) }
          : configWithApiKey;

        // 1M context beta header is injected per-request via buildRequestHeaders() →
        // streamText({ headers }), not at provider creation time. This avoids duplicating
        // header logic across direct and gateway handlers.

        // Lazy-load Anthropic provider to reduce startup time
        const { createAnthropic } = await PROVIDER_REGISTRY.anthropic();
        // Wrap fetch to inject cache_control on tools and messages
        // (SDK doesn't translate providerOptions to cache_control for these)
        // Use getProviderFetch to preserve any user-configured custom fetch (e.g., proxies)
        const baseFetch = getProviderFetch(providerConfig);
        const fetchWithCacheControl = wrapFetchWithAnthropicCacheControl(
          baseFetch,
          effectiveAnthropicCacheTtl
        );
        const provider = createAnthropic({
          ...normalizedConfig,
          fetch: fetchWithCacheControl,
        });
        return Ok(provider(modelId));
      }

      // Handle OpenAI provider (using Responses API)
      if (providerName === "openai") {
        const fullModelId = `${providerName}:${modelId}`;

        const codexOauthAllowed = isCodexOauthAllowedModelId(fullModelId);
        const codexOauthRequired = isCodexOauthRequiredModelId(fullModelId);

        const storedCodexOauth = parseCodexOauthAuth(
          (providerConfig as { codexOauth?: unknown }).codexOauth
        );

        // Resolve credentials from config + env BEFORE OAuth checks so we can
        // fall back to an API key when OAuth is not connected.
        const creds = resolveProviderCredentials("openai", providerConfig);

        // When a model requires Codex OAuth but the user hasn't connected it,
        // fall back to their API key instead of blocking entirely.  If the model
        // truly only works through OAuth, OpenAI's API will return a clear error.
        if (codexOauthRequired && !storedCodexOauth && !creds.isConfigured) {
          return Err({ type: "oauth_not_connected", provider: providerName });
        }

        const codexOauthDefaultAuthRaw = (providerConfig as { codexOauthDefaultAuth?: unknown })
          .codexOauthDefaultAuth;
        const codexOauthDefaultAuth = codexOauthDefaultAuthRaw === "apiKey" ? "apiKey" : "oauth";

        // Codex OAuth routing:
        // - Required models route through ChatGPT OAuth when connected.
        // - If OAuth is not connected, fall back to API key (if available).
        // - Allowed models route through OAuth only when:
        //   - no API key is configured, OR
        //   - the user prefers OAuth when both are set.
        const shouldRouteThroughCodexOauth = (() => {
          if (!codexOauthAllowed || !storedCodexOauth) {
            return false;
          }

          if (codexOauthRequired) {
            return true;
          }

          if (!creds.isConfigured) {
            return true;
          }

          return codexOauthDefaultAuth === "oauth";
        })();

        if (!shouldRouteThroughCodexOauth && !creds.isConfigured) {
          return Err({ type: "api_key_not_found", provider: providerName });
        }

        // Merge resolved credentials into config
        const configWithCreds = {
          ...providerConfig,
          // When using Codex OAuth, we overwrite auth headers in fetch(), so the OpenAI API key
          // isn't required. Still pass a placeholder to ensure the SDK never reads env vars.
          apiKey: shouldRouteThroughCodexOauth ? (creds.apiKey ?? "codex-oauth") : creds.apiKey,
          ...(creds.baseUrl && !providerConfig.baseURL && { baseURL: creds.baseUrl }),
          ...(creds.organization && { organization: creds.organization }),
        };

        // Extract serviceTier from config to pass through to buildProviderOptions
        const configServiceTier = providerConfig.serviceTier as string | undefined;
        if (configServiceTier && muxProviderOptions) {
          muxProviderOptions.openai = {
            ...muxProviderOptions.openai,
            serviceTier: configServiceTier as "auto" | "default" | "flex" | "priority",
          };
        }

        const baseFetch = getProviderFetch(providerConfig);
        const codexOauthService = this.codexOauthService;

        // Wrap fetch to default truncation to "disabled" for OpenAI Responses API calls.
        // This preserves our compaction handling while still allowing explicit truncation (e.g., auto).
        const fetchWithOpenAITruncation = Object.assign(
          async (
            input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1]
          ): Promise<Response> => {
            try {
              const urlString = (() => {
                if (typeof input === "string") {
                  return input;
                }
                if (input instanceof URL) {
                  return input.toString();
                }
                if (typeof input === "object" && input !== null && "url" in input) {
                  const possibleUrl = (input as { url?: unknown }).url;
                  if (typeof possibleUrl === "string") {
                    return possibleUrl;
                  }
                }
                return "";
              })();

              const method = (init?.method ?? "GET").toUpperCase();
              const isOpenAIResponses = /\/v1\/responses(\?|$)/.test(urlString);
              const isOpenAIChatCompletions = /\/chat\/completions(\?|$)/.test(urlString);

              let nextInput: Parameters<typeof fetch>[0] = input;
              let nextInit: Parameters<typeof fetch>[1] | undefined = init;

              const body = init?.body;
              // Only parse the JSON body when routing through Codex OAuth — it needs
              // instruction lifting, store=false, and truncation enforcement.  For
              // non-Codex requests the SDK already sends the correct truncation value
              // via providerOptions, so we skip the expensive parse + re-stringify.
              if (
                shouldRouteThroughCodexOauth &&
                isOpenAIResponses &&
                method === "POST" &&
                typeof body === "string"
              ) {
                try {
                  const json = JSON.parse(body) as Record<string, unknown>;
                  const truncation = json.truncation;
                  if (truncation !== "auto" && truncation !== "disabled") {
                    json.truncation = "disabled";
                  }

                  // Codex OAuth (chatgpt.com/backend-api/codex/responses) rejects requests unless
                  // `instructions` is present and non-empty, and `store` is set to false.
                  // The AI SDK maps `system` prompts into the `input` array
                  // (role: system|developer) but does *not* automatically populate
                  // `instructions`, so we lift all system prompts into `instructions` when
                  // routing through Codex OAuth.

                  // Codex endpoint requires store=false and only accepts a subset of the
                  // standard OpenAI Responses API parameters. Use an allowlist to strip
                  // everything the endpoint doesn't understand (it rejects unknown params
                  // with 400).
                  json.store = false;

                  const CODEX_ALLOWED_PARAMS = new Set([
                    "model",
                    "input",
                    "instructions",
                    "tools",
                    "tool_choice",
                    "parallel_tool_calls",
                    "stream",
                    "store",
                    "prompt_cache_key",
                    "reasoning",
                    "temperature",
                    "top_p",
                    "include",
                    "text", // structured output via Output.object → text.format
                  ]);

                  for (const key of Object.keys(json)) {
                    if (!CODEX_ALLOWED_PARAMS.has(key)) {
                      delete json[key];
                    }
                  }

                  // Filter out item_reference entries from the input. The AI SDK sends
                  // these as an optimization when store=true — bare { type: "item_reference",
                  // id: "rs_..." } objects that the server expands by looking up stored
                  // content. With store=false (required for Codex), these lookups fail.
                  // The full inline content is always present alongside references, so
                  // removing them doesn't lose conversation context.
                  if (Array.isArray(json.input)) {
                    json.input = (json.input as Array<Record<string, unknown>>).filter(
                      (item) =>
                        !(item && typeof item === "object" && item.type === "item_reference")
                    );
                  }

                  const existingInstructions =
                    typeof json.instructions === "string" ? json.instructions.trim() : "";

                  if (existingInstructions.length === 0) {
                    const derivedParts: string[] = [];
                    const keptInput: unknown[] = [];

                    const responseInput = json.input;
                    if (Array.isArray(responseInput)) {
                      for (const item of responseInput as unknown[]) {
                        if (!item || typeof item !== "object") {
                          keptInput.push(item);
                          continue;
                        }

                        const role = (item as { role?: unknown }).role;
                        if (role !== "system" && role !== "developer") {
                          keptInput.push(item);
                          continue;
                        }

                        // Extract text from string content or structured content arrays
                        // (AI SDK may produce [{type:"text", text:"..."}])
                        const content = (item as { content?: unknown }).content;
                        const text = extractTextContent(content);
                        if (text.length > 0) {
                          derivedParts.push(text);
                        }
                        // Drop this system/developer item from input (don't push to keptInput)
                      }

                      json.input = keptInput;
                    }

                    const joined = derivedParts.join("\n\n").trim();
                    json.instructions = joined.length > 0 ? joined : "You are a helpful assistant.";
                  }

                  // Clone headers to avoid mutating caller-provided objects
                  const headers = new Headers(init?.headers);
                  // Remove content-length if present, since body will change
                  headers.delete("content-length");

                  const newBody = JSON.stringify(json);
                  nextInit = { ...init, headers, body: newBody };
                } catch {
                  // If body isn't JSON, fall through to normal fetch (but still allow Codex routing).
                }
              }

              if (shouldRouteThroughCodexOauth && (isOpenAIResponses || isOpenAIChatCompletions)) {
                if (!codexOauthService) {
                  throw new Error("Codex OAuth service not initialized");
                }

                const authResult = await codexOauthService.getValidAuth();
                if (!authResult.success) {
                  throw new Error(authResult.error);
                }

                const headers = new Headers(nextInit?.headers);
                headers.set("Authorization", `Bearer ${authResult.data.access}`);
                if (authResult.data.accountId) {
                  headers.set("ChatGPT-Account-Id", authResult.data.accountId);
                }

                nextInput = CODEX_ENDPOINT;
                nextInit = { ...(nextInit ?? {}), headers };
              }

              return baseFetch(nextInput, nextInit);
            } catch (error) {
              // For normal OpenAI (API key) requests, fall back to the original fetch on unexpected errors.
              // For Codex OAuth routing, failures should surface (falling back would hit api.openai.com).
              if (shouldRouteThroughCodexOauth) {
                throw error;
              }
              return baseFetch(input, init);
            }
          },
          "preconnect" in baseFetch && typeof baseFetch.preconnect === "function"
            ? {
                preconnect: baseFetch.preconnect.bind(baseFetch),
              }
            : {}
        );

        // Lazy-load OpenAI provider to reduce startup time
        const { createOpenAI } = await PROVIDER_REGISTRY.openai();
        const provider = createOpenAI({
          ...configWithCreds,
          // Cast is safe: our fetch implementation is compatible with the SDK's fetch type.
          // The preconnect method is optional in our implementation but required by the SDK type.
          fetch: fetchWithOpenAITruncation as typeof fetch,
        });
        // Use Responses API for persistence and built-in tools
        // OpenAI manages reasoning state via previousResponseId - no middleware needed
        const model = provider.responses(modelId);
        if (shouldRouteThroughCodexOauth) {
          markModelCostsIncluded(model);

          // Wrap model to inject store=false into providerOptions so the SDK
          // sends full inline content instead of item_reference lookups.
          // The Codex endpoint requires store=false; without this, the SDK
          // defaults to store=true and sends bare { type: "item_reference" }
          // items that can't be resolved.
          const injectStoreFlag = (
            options: Parameters<typeof model.doStream>[0]
          ): Parameters<typeof model.doStream>[0] => {
            const openaiOpts =
              (options.providerOptions?.openai as Record<string, unknown> | undefined) ?? {};
            return {
              ...options,
              providerOptions: {
                ...options.providerOptions,
                openai: {
                  ...openaiOpts,
                  store: false,
                },
              },
            };
          };

          const originalDoStream = model.doStream.bind(model);
          const originalDoGenerate = model.doGenerate.bind(model);
          model.doStream = (options) => originalDoStream(injectStoreFlag(options));
          model.doGenerate = (options) => originalDoGenerate(injectStoreFlag(options));
        }
        return Ok(model);
      }

      // Handle xAI provider
      if (providerName === "xai") {
        // Resolve credentials from config + env (single source of truth)
        const creds = resolveProviderCredentials("xai", providerConfig);
        if (!creds.isConfigured) {
          return Err({ type: "api_key_not_found", provider: providerName });
        }

        const baseFetch = getProviderFetch(providerConfig);
        const { apiKey: _apiKey, baseURL, headers, ...extraOptions } = providerConfig;

        const { searchParameters, ...restOptions } = extraOptions as {
          searchParameters?: Record<string, unknown>;
        } & Record<string, unknown>;

        if (searchParameters && muxProviderOptions) {
          const existingXaiOverrides = muxProviderOptions.xai ?? {};
          muxProviderOptions.xai = {
            ...existingXaiOverrides,
            searchParameters:
              existingXaiOverrides.searchParameters ??
              (searchParameters as XaiProviderOptions["searchParameters"]),
          };
        }

        const { createXai } = await PROVIDER_REGISTRY.xai();
        const provider = createXai({
          apiKey: creds.apiKey,
          baseURL: creds.baseUrl ?? baseURL,
          headers,
          ...restOptions,
          fetch: baseFetch,
        });
        return Ok(provider(modelId));
      }

      // Handle Ollama provider
      if (providerName === "ollama") {
        // Ollama doesn't require API key - it's a local service
        const baseFetch = getProviderFetch(providerConfig);

        // Lazy-load Ollama provider to reduce startup time
        const { createOllama } = await PROVIDER_REGISTRY.ollama();
        const provider = createOllama({
          ...providerConfig,
          fetch: baseFetch,
          // Use strict mode for better compatibility with Ollama API
          compatibility: "strict",
        });
        return Ok(provider(modelId));
      }

      // Handle OpenRouter provider
      if (providerName === "openrouter") {
        // Resolve credentials from config + env (single source of truth)
        const creds = resolveProviderCredentials("openrouter", providerConfig);
        if (!creds.isConfigured) {
          return Err({ type: "api_key_not_found", provider: providerName });
        }
        const baseFetch = getProviderFetch(providerConfig);

        // Extract standard provider settings (apiKey, baseUrl, headers, fetch)
        const {
          apiKey: _apiKey,
          baseUrl,
          headers,
          fetch: _fetch,
          ...extraOptions
        } = providerConfig;

        // OpenRouter routing options that need to be nested under "provider" in API request
        // See: https://openrouter.ai/docs/features/provider-routing
        const OPENROUTER_ROUTING_OPTIONS = [
          "order",
          "allow_fallbacks",
          "only",
          "ignore",
          "require_parameters",
          "data_collection",
          "sort",
          "quantizations",
        ];

        // Build extraBody: routing options go under "provider", others stay at root
        const routingOptions: Record<string, unknown> = {};
        const otherOptions: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(extraOptions)) {
          if (OPENROUTER_ROUTING_OPTIONS.includes(key)) {
            routingOptions[key] = value;
          } else {
            otherOptions[key] = value;
          }
        }

        // Build extraBody with provider nesting if routing options exist
        let extraBody: Record<string, unknown> | undefined;
        if (Object.keys(routingOptions).length > 0) {
          extraBody = { provider: routingOptions, ...otherOptions };
        } else if (Object.keys(otherOptions).length > 0) {
          extraBody = otherOptions;
        }

        // Lazy-load OpenRouter provider to reduce startup time
        const { createOpenRouter } = await PROVIDER_REGISTRY.openrouter();
        const provider = createOpenRouter({
          apiKey: creds.apiKey,
          baseURL: creds.baseUrl ?? baseUrl,
          headers,
          fetch: baseFetch,
          extraBody,
        });
        return Ok(provider(modelId));
      }

      // Handle Amazon Bedrock provider
      if (providerName === "bedrock") {
        // Resolve region from config + env (single source of truth)
        const creds = resolveProviderCredentials("bedrock", providerConfig);
        if (!creds.isConfigured || !creds.region) {
          return Err({ type: "api_key_not_found", provider: providerName });
        }
        const { region } = creds;

        // Optional AWS shared config profile name (equivalent to AWS_PROFILE).
        // Useful for SSO profiles when Mux isn't launched with AWS_PROFILE set.
        const profile =
          typeof providerConfig.profile === "string" && providerConfig.profile.trim()
            ? providerConfig.profile.trim()
            : undefined;

        const baseFetch = getProviderFetch(providerConfig);
        const { createAmazonBedrock } = await PROVIDER_REGISTRY.bedrock();

        // Check if explicit credentials are provided in config
        const hasExplicitCredentials = providerConfig.accessKeyId && providerConfig.secretAccessKey;

        if (hasExplicitCredentials) {
          // Use explicit credentials from providers.jsonc
          const provider = createAmazonBedrock({
            ...providerConfig,
            region,
            fetch: baseFetch,
          });
          return Ok(provider(modelId));
        }

        // Check for Bedrock bearer token (simplest auth) - from config or environment
        // The SDK's apiKey option maps to AWS_BEARER_TOKEN_BEDROCK
        const bearerToken =
          typeof providerConfig.bearerToken === "string" ? providerConfig.bearerToken : undefined;

        if (bearerToken) {
          const provider = createAmazonBedrock({
            region,
            apiKey: bearerToken,
            fetch: baseFetch,
          });
          return Ok(provider(modelId));
        }

        // Check if AWS_BEARER_TOKEN_BEDROCK env var is set
        if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
          // SDK automatically picks this up via apiKey option
          const provider = createAmazonBedrock({
            region,
            fetch: baseFetch,
          });
          return Ok(provider(modelId));
        }

        // Use AWS credential provider chain for flexible authentication:
        // - Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
        // - Shared credentials file (~/.aws/credentials)
        // - EC2 instance profiles
        // - ECS task roles
        // - EKS service account (IRSA)
        // - SSO credentials
        // - And more...
        const provider = createAmazonBedrock({
          region,
          credentialProvider: fromNodeProviderChain(profile ? { profile } : {}),
          fetch: baseFetch,
        });
        return Ok(provider(modelId));
      }

      // Handle Mux Gateway provider
      if (providerName === "mux-gateway") {
        // Resolve couponCode from config (single source of truth)
        const creds = resolveProviderCredentials("mux-gateway", providerConfig);
        if (!creds.isConfigured || !creds.couponCode) {
          return Err({ type: "api_key_not_found", provider: providerName });
        }
        const { couponCode } = creds;

        const { createGateway } = await PROVIDER_REGISTRY["mux-gateway"]();
        // For Anthropic models via gateway, wrap fetch to inject cache_control on tools
        // (gateway provider doesn't process providerOptions.anthropic.cacheControl)
        // Use getProviderFetch to preserve any user-configured custom fetch (e.g., proxies)
        const baseFetch = getProviderFetch(providerConfig);
        const isAnthropicModel = modelId.startsWith("anthropic/");
        const fetchWithCacheControl = isAnthropicModel
          ? wrapFetchWithAnthropicCacheControl(baseFetch, effectiveAnthropicCacheTtl)
          : baseFetch;
        const fetchWithAutoLogout = wrapFetchWithMuxGatewayAutoLogout(
          fetchWithCacheControl,
          this.providerService
        );
        // Use configured baseURL or fall back to default gateway URL
        const gatewayBaseURL =
          providerConfig.baseURL ?? "https://gateway.mux.coder.com/api/v1/ai-gateway/v1/ai";

        // 1M context beta header is injected per-request via buildRequestHeaders() →
        // streamText({ headers }), not at provider creation time.
        const gateway = createGateway({
          apiKey: couponCode,
          baseURL: gatewayBaseURL,
          fetch: fetchWithAutoLogout,
        });
        const model = gateway(modelId);

        // Normalize usage format from the gateway server.
        // The gateway SDK declares specificationVersion "v3", so the AI SDK core
        // expects nested v3 usage: { inputTokens: { total, ... }, outputTokens: { total, ... } }.
        // However the gateway server may return flat v2-style usage
        // (e.g. { inputTokens: 123, outputTokens: 456 }), causing
        // asLanguageModelUsage to produce undefined → 0 for all token counts.
        // These wrappers detect flat usage and convert to v3 nested format.
        const originalDoStream = model.doStream.bind(model);
        model.doStream = async (options) => {
          const result = await originalDoStream(options);
          return {
            ...result,
            // Type assertion safe: the transform only modifies the shape of usage/finishReason
            // fields within existing chunks, it doesn't change the stream part types.
            stream: result.stream.pipeThrough(
              normalizeGatewayStreamUsage()
            ) as typeof result.stream,
          };
        };

        const originalDoGenerate = model.doGenerate.bind(model);
        model.doGenerate = async (options) => {
          const result = await originalDoGenerate(options);
          return normalizeGatewayGenerateResult(result);
        };

        return Ok(model);
      }

      // GitHub Copilot — OpenAI-compatible with custom auth headers
      if (providerName === "github-copilot") {
        const creds = resolveProviderCredentials("github-copilot" as ProviderName, providerConfig);
        if (!creds.isConfigured) {
          return Err({ type: "api_key_not_found", provider: providerName });
        }

        const { createOpenAICompatible } = await PROVIDER_REGISTRY["github-copilot"]();

        const baseFetch = getProviderFetch(providerConfig);
        const copilotFetchFn = async (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1]
        ) => {
          const headers = new Headers(init?.headers);
          headers.set("Authorization", `Bearer ${creds.apiKey ?? ""}`);
          headers.set("Openai-Intent", "conversation-edits");
          headers.delete("x-api-key");
          return baseFetch(input, { ...init, headers });
        };
        const copilotFetch = Object.assign(copilotFetchFn, baseFetch) as typeof fetch;

        const baseURL = providerConfig.baseURL ?? "https://api.githubcopilot.com";
        const provider = createOpenAICompatible({
          name: "github-copilot",
          baseURL,
          apiKey: "copilot", // placeholder — actual auth via custom fetch
          fetch: copilotFetch,
        });
        return Ok(provider.chatModel(modelId));
      }

      // Generic handler for simple providers (standard API key + factory pattern)
      // Providers with custom logic (anthropic, openai, xai, ollama, openrouter, bedrock, mux-gateway,
      // github-copilot) are handled explicitly above. New providers using the standard pattern need
      // only be added to PROVIDER_DEFINITIONS - no code changes required here.
      const providerDef = PROVIDER_DEFINITIONS[providerName as ProviderName];
      if (providerDef) {
        // Resolve credentials from config + env (single source of truth)
        const creds = resolveProviderCredentials(providerName as ProviderName, providerConfig);
        if (providerDef.requiresApiKey && !creds.isConfigured) {
          return Err({ type: "api_key_not_found", provider: providerName });
        }

        // Lazy-load and create provider using factoryName from definition
        const providerModule = (await providerDef.import()) as unknown as Record<
          string,
          (config: Record<string, unknown>) => (modelId: string) => LanguageModel
        >;
        const factory = providerModule[providerDef.factoryName];
        if (!factory) {
          return Err({
            type: "provider_not_supported",
            provider: providerName,
          });
        }

        // Merge resolved credentials into config
        const configWithCreds = {
          ...providerConfig,
          ...(creds.apiKey && { apiKey: creds.apiKey }),
          ...(creds.baseUrl && !providerConfig.baseURL && { baseURL: creds.baseUrl }),
        };

        const provider = factory({
          ...configWithCreds,
          fetch: getProviderFetch(providerConfig),
        });
        return Ok(provider(modelId));
      }

      return Err({
        type: "provider_not_supported",
        provider: providerName,
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      return Err({ type: "unknown", raw: `Failed to create model: ${errorMessage}` });
    }
  }

  /**
   * Resolve model string (xAI variant mapping + gateway routing) and create the model.
   *
   * Combines the xAI thinking-level variant swap, gateway resolution, and model
   * creation into a single call. Previously this logic was inlined in
   * `AIService.streamMessage()`.
   *
   * @returns On success: the created model + resolution metadata.
   */
  async resolveAndCreateModel(
    modelString: string,
    thinkingLevel: ThinkingLevel,
    muxProviderOptions?: MuxProviderOptions
  ): Promise<
    Result<
      {
        model: LanguageModel;
        /** Model string after gateway routing (may have `mux-gateway:` prefix). */
        effectiveModelString: string;
        /** Model string with gateway prefix stripped (canonical provider:model). */
        canonicalModelString: string;
        /** Provider name from the canonical model string. */
        canonicalProviderName: string;
        /** Model ID from the canonical model string. */
        canonicalModelId: string;
        /** Whether the request is being routed through the Mux gateway. */
        routedThroughGateway: boolean;
      },
      SendMessageError
    >
  > {
    const explicitlyRequestedGateway = modelString.trim().startsWith("mux-gateway:");
    const canonicalModelString = normalizeGatewayModel(modelString);
    let effectiveModelString = canonicalModelString;
    const [canonicalProviderName, canonicalModelId] = parseModelString(canonicalModelString);

    // xAI Grok: swap between reasoning and non-reasoning variants based on thinking level.
    // xAI only supports full reasoning (no medium/low).
    if (canonicalProviderName === "xai" && canonicalModelId === "grok-4-1-fast") {
      const variant =
        thinkingLevel !== "off" ? "grok-4-1-fast-reasoning" : "grok-4-1-fast-non-reasoning";
      effectiveModelString = `xai:${variant}`;
    }

    effectiveModelString = this.resolveGatewayModelString(
      effectiveModelString,
      canonicalModelString,
      explicitlyRequestedGateway
    );

    const routedThroughGateway = effectiveModelString.startsWith("mux-gateway:");
    const modelResult = await this.createModel(effectiveModelString, muxProviderOptions);
    if (!modelResult.success) {
      return Err(modelResult.error);
    }

    return Ok({
      model: modelResult.data,
      effectiveModelString,
      canonicalModelString,
      canonicalProviderName,
      canonicalModelId,
      routedThroughGateway,
    });
  }
  resolveGatewayModelString(
    modelString: string,
    modelKey?: string,
    explicitlyRequestedGateway = false
  ): string {
    // Backend-authoritative routing avoids frontend localStorage races (issue #1769).
    const canonicalModelString = normalizeGatewayModel(modelString);
    const normalizedModelKey = modelKey ? normalizeGatewayModel(modelKey) : canonicalModelString;
    const [providerName, modelId] = parseModelString(canonicalModelString);

    if (!providerName || !modelId) {
      return canonicalModelString;
    }

    if (providerName === "mux-gateway" || !(providerName in PROVIDER_REGISTRY)) {
      return canonicalModelString;
    }

    const typedProvider = providerName as ProviderName;
    if (!MUX_GATEWAY_SUPPORTED_PROVIDERS.has(typedProvider)) {
      return canonicalModelString;
    }

    const config = this.config.loadConfigOrDefault();
    const gatewayEnabled = config.muxGatewayEnabled !== false;
    const gatewayModels = config.muxGatewayModels ?? [];
    // Legacy clients may still send mux-gateway model IDs before the backend config
    // has synchronized their allowlist, so honor an explicit mux-gateway prefix as
    // an implicit opt-in to avoid first-message API key failures.
    const isGatewayModelEnabled =
      explicitlyRequestedGateway ||
      gatewayModels.includes(canonicalModelString) ||
      gatewayModels.includes(normalizedModelKey);

    if (!gatewayEnabled || !isGatewayModelEnabled) {
      return canonicalModelString;
    }

    const providersConfig = this.config.loadProvidersConfig() ?? {};
    const gatewayConfig = providersConfig["mux-gateway"] ?? {};
    const gatewayConfigured = resolveProviderCredentials("mux-gateway", gatewayConfig).isConfigured;

    if (!gatewayConfigured) {
      return canonicalModelString;
    }

    return `mux-gateway:${providerName}/${modelId}`;
  }
}
