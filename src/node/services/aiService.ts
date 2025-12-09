import * as fs from "fs/promises";
import * as os from "os";
import { EventEmitter } from "events";
import type { XaiProviderOptions } from "@ai-sdk/xai";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { convertToModelMessages, type LanguageModel, type Tool } from "ai";
import { applyToolOutputRedaction } from "@/browser/utils/messages/applyToolOutputRedaction";
import { sanitizeToolInputs } from "@/browser/utils/messages/sanitizeToolInput";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import {
  PROVIDER_REGISTRY,
  PROVIDER_DEFINITIONS,
  type ProviderName,
} from "@/common/constants/providers";

import type { MuxMessage, MuxTextPart } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type { Config, ProviderConfig } from "@/node/config";
import { StreamManager } from "./streamManager";
import type { InitStateManager } from "./initStateManager";
import type { SendMessageError } from "@/common/types/errors";
import { getToolsForModel } from "@/common/utils/tools/tools";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { getMuxEnv, getRuntimeType } from "@/node/runtime/initHook";
import { secretsToRecord } from "@/common/types/secrets";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { FileState, EditedFileAttachment } from "@/node/services/agentSession";
import { log } from "./log";
import {
  transformModelMessages,
  validateAnthropicCompliance,
  addInterruptedSentinel,
  filterEmptyAssistantMessages,
  injectModeTransition,
  injectFileChangeNotifications,
  injectPostCompactionAttachments,
} from "@/browser/utils/messages/modelMessageTransform";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import { applyCacheControl } from "@/common/utils/ai/cacheStrategy";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";
import { buildSystemMessage, readToolInstructions } from "./systemMessage";
import { getTokenizerForModel } from "@/node/utils/main/tokenizer";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import { buildProviderOptions } from "@/common/utils/ai/providerOptions";
import type { ThinkingLevel } from "@/common/types/thinking";
import type {
  StreamAbortEvent,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamStartEvent,
} from "@/common/types/stream";
import { applyToolPolicy, type ToolPolicy } from "@/common/utils/tools/toolPolicy";
import { MockScenarioPlayer } from "./mock/mockScenarioPlayer";
import { EnvHttpProxyAgent, type Dispatcher } from "undici";
import { getPlanFilePath } from "@/common/utils/planStorage";
import { getPlanModeInstruction } from "@/common/utils/ui/modeUtils";
import type { UIMode } from "@/common/types/mode";
import { readPlanFile } from "@/node/utils/runtime/helpers";

// Export a standalone version of getToolsForModel for use in backend

// Create undici agent with unlimited timeouts for AI streaming requests.
// Safe because users control cancellation via AbortSignal from the UI.
// Uses EnvHttpProxyAgent to automatically respect HTTP_PROXY, HTTPS_PROXY,
// and NO_PROXY environment variables for debugging/corporate network support.
const unlimitedTimeoutAgent = new EnvHttpProxyAgent({
  bodyTimeout: 0, // No timeout - prevents BodyTimeoutError on long reasoning pauses
  headersTimeout: 0, // No timeout for headers
});

// Extend RequestInit with undici-specific dispatcher property (Node.js only)
type RequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

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
  // dispatcher is a Node.js undici-specific property for custom HTTP agents
  const requestInit: RequestInitWithDispatcher = {
    ...(init ?? {}),
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
function wrapFetchWithAnthropicCacheControl(baseFetch: typeof fetch): typeof fetch {
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

      // Inject cache_control on the last tool if tools array exists
      if (Array.isArray(json.tools) && json.tools.length > 0) {
        const lastTool = json.tools[json.tools.length - 1] as Record<string, unknown>;
        lastTool.cache_control ??= { type: "ephemeral" };
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
          anthropicOpts.cacheControl ??= { type: "ephemeral" };
          providerOpts.anthropic = anthropicOpts;
          lastMsg.providerOptions = providerOpts;
        }

        // For direct Anthropic: add cache_control to last content part
        const content = lastMsg.content;
        if (Array.isArray(content) && content.length > 0) {
          const lastPart = content[content.length - 1] as Record<string, unknown>;
          lastPart.cache_control ??= { type: "ephemeral" };
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
 * Get fetch function for provider - use custom if provided, otherwise unlimited timeout default
 */
function getProviderFetch(providerConfig: ProviderConfig): typeof fetch {
  return typeof providerConfig.fetch === "function"
    ? (providerConfig.fetch as typeof fetch)
    : defaultFetchWithUnlimitedTimeout;
}

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

/** Header value for Anthropic 1M context beta */
export const ANTHROPIC_1M_CONTEXT_HEADER = "context-1m-2025-08-07";

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
function parseModelString(modelString: string): [string, string] {
  const colonIndex = modelString.indexOf(":");
  const providerName = colonIndex !== -1 ? modelString.slice(0, colonIndex) : modelString;
  const modelId = colonIndex !== -1 ? modelString.slice(colonIndex + 1) : "";
  return [providerName, modelId];
}

export class AIService extends EventEmitter {
  private readonly streamManager: StreamManager;
  private readonly historyService: HistoryService;
  private readonly partialService: PartialService;
  private readonly config: Config;
  private mcpServerManager?: MCPServerManager;
  private readonly initStateManager: InitStateManager;
  private readonly mockModeEnabled: boolean;
  private readonly mockScenarioPlayer?: MockScenarioPlayer;
  private readonly backgroundProcessManager?: BackgroundProcessManager;

  constructor(
    config: Config,
    historyService: HistoryService,
    partialService: PartialService,
    initStateManager: InitStateManager,
    backgroundProcessManager?: BackgroundProcessManager
  ) {
    super();
    // Increase max listeners to accommodate multiple concurrent workspace listeners
    // Each workspace subscribes to stream events, and we expect >10 concurrent workspaces
    this.setMaxListeners(50);
    this.config = config;
    this.historyService = historyService;
    this.partialService = partialService;
    this.initStateManager = initStateManager;
    this.backgroundProcessManager = backgroundProcessManager;
    this.streamManager = new StreamManager(historyService, partialService);
    void this.ensureSessionsDir();
    this.setupStreamEventForwarding();
    this.mockModeEnabled = process.env.MUX_MOCK_AI === "1";
    if (this.mockModeEnabled) {
      log.info("AIService running in MUX_MOCK_AI mode");
      this.mockScenarioPlayer = new MockScenarioPlayer({
        aiService: this,
        historyService,
      });
    }
  }

  setMCPServerManager(manager: MCPServerManager): void {
    this.mcpServerManager = manager;
  }

  /**
   * Forward all stream events from StreamManager to AIService consumers
   */
  private setupStreamEventForwarding(): void {
    this.streamManager.on("stream-start", (data) => this.emit("stream-start", data));
    this.streamManager.on("stream-delta", (data) => this.emit("stream-delta", data));
    this.streamManager.on("stream-end", (data) => this.emit("stream-end", data));

    // Handle stream-abort: dispose of partial based on abandonPartial flag
    this.streamManager.on("stream-abort", (data: StreamAbortEvent) => {
      void (async () => {
        if (data.abandonPartial) {
          // Caller requested discarding partial - delete without committing
          await this.partialService.deletePartial(data.workspaceId);
        } else {
          // Commit interrupted message to history with partial:true metadata
          // This ensures /clear and /truncate can clean up interrupted messages
          const partial = await this.partialService.readPartial(data.workspaceId);
          if (partial) {
            await this.partialService.commitToHistory(data.workspaceId);
            await this.partialService.deletePartial(data.workspaceId);
          }
        }

        // Forward abort event to consumers
        this.emit("stream-abort", data);
      })();
    });

    this.streamManager.on("error", (data) => this.emit("error", data));
    // Forward tool events
    this.streamManager.on("tool-call-start", (data) => this.emit("tool-call-start", data));
    this.streamManager.on("tool-call-delta", (data) => this.emit("tool-call-delta", data));
    this.streamManager.on("tool-call-end", (data) => this.emit("tool-call-end", data));
    // Forward reasoning events
    this.streamManager.on("reasoning-delta", (data) => this.emit("reasoning-delta", data));
    this.streamManager.on("reasoning-end", (data) => this.emit("reasoning-end", data));
    this.streamManager.on("usage-delta", (data) => this.emit("usage-delta", data));
  }

  private async ensureSessionsDir(): Promise<void> {
    try {
      await fs.mkdir(this.config.sessionsDir, { recursive: true });
    } catch (error) {
      log.error("Failed to create sessions directory:", error);
    }
  }

  isMockModeEnabled(): boolean {
    return this.mockModeEnabled;
  }

  async getWorkspaceMetadata(workspaceId: string): Promise<Result<WorkspaceMetadata>> {
    try {
      // Read from config.json (single source of truth)
      // getAllWorkspaceMetadata() handles migration from legacy metadata.json files
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const metadata = allMetadata.find((m) => m.id === workspaceId);

      if (!metadata) {
        return Err(
          `Workspace metadata not found for ${workspaceId}. Workspace may not be properly initialized.`
        );
      }

      return Ok(metadata);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to read workspace metadata: ${message}`);
    }
  }

  /**
   * Split assistant messages that have text after tool calls with results.

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
      // Parse model string (format: "provider:model-id")
      // Parse provider and model ID from model string
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

      // Load providers configuration - the ONLY source of truth
      const providersConfig = this.config.loadProvidersConfig();
      let providerConfig = providersConfig?.[providerName] ?? {};

      // Map baseUrl to baseURL if present (SDK expects baseURL)
      const { baseUrl, ...configWithoutBaseUrl } = providerConfig;
      providerConfig = baseUrl
        ? { ...configWithoutBaseUrl, baseURL: baseUrl }
        : configWithoutBaseUrl;

      // Handle Anthropic provider
      if (providerName === "anthropic") {
        // Anthropic API key can come from:
        // 1. providers.jsonc config (providerConfig.apiKey)
        // 2. ANTHROPIC_API_KEY env var (SDK reads this automatically)
        // 3. ANTHROPIC_AUTH_TOKEN env var (we pass this explicitly since SDK doesn't check it)
        // We allow env var passthrough so users don't need explicit config.

        const hasApiKeyInConfig = Boolean(providerConfig.apiKey);
        const hasApiKeyEnvVar = Boolean(process.env.ANTHROPIC_API_KEY);
        const hasAuthTokenEnvVar = Boolean(process.env.ANTHROPIC_AUTH_TOKEN);

        // Return structured error if no credentials available anywhere
        if (!hasApiKeyInConfig && !hasApiKeyEnvVar && !hasAuthTokenEnvVar) {
          return Err({
            type: "api_key_not_found",
            provider: providerName,
          });
        }

        // If SDK won't find a key (no config, no ANTHROPIC_API_KEY), use ANTHROPIC_AUTH_TOKEN
        let configWithApiKey = providerConfig;
        if (!hasApiKeyInConfig && !hasApiKeyEnvVar && hasAuthTokenEnvVar) {
          configWithApiKey = { ...providerConfig, apiKey: process.env.ANTHROPIC_AUTH_TOKEN };
        }

        // Normalize base URL to ensure /v1 suffix (SDK expects it).
        // Check config first, then fall back to ANTHROPIC_BASE_URL env var.
        // We must explicitly pass baseURL to ensure /v1 normalization happens
        // (SDK reads env var but doesn't normalize it).
        const baseURLFromEnv = process.env.ANTHROPIC_BASE_URL?.trim();
        const effectiveBaseURL = configWithApiKey.baseURL ?? baseURLFromEnv;
        const normalizedConfig = effectiveBaseURL
          ? { ...configWithApiKey, baseURL: normalizeAnthropicBaseURL(effectiveBaseURL) }
          : configWithApiKey;

        // Add 1M context beta header if requested
        const headers = buildAnthropicHeaders(
          normalizedConfig.headers,
          muxProviderOptions?.anthropic?.use1MContext
        );

        // Lazy-load Anthropic provider to reduce startup time
        const { createAnthropic } = await PROVIDER_REGISTRY.anthropic();
        // Wrap fetch to inject cache_control on tools and messages
        // (SDK doesn't translate providerOptions to cache_control for these)
        // Use getProviderFetch to preserve any user-configured custom fetch (e.g., proxies)
        const baseFetch = getProviderFetch(providerConfig);
        const fetchWithCacheControl = wrapFetchWithAnthropicCacheControl(baseFetch);
        const provider = createAnthropic({
          ...normalizedConfig,
          headers,
          fetch: fetchWithCacheControl,
        });
        return Ok(provider(modelId));
      }

      // Handle OpenAI provider (using Responses API)
      if (providerName === "openai") {
        if (!providerConfig.apiKey) {
          return Err({
            type: "api_key_not_found",
            provider: providerName,
          });
        }
        const baseFetch = getProviderFetch(providerConfig);

        // Wrap fetch to force truncation: "auto" for OpenAI Responses API calls.
        // This is a temporary override until @ai-sdk/openai supports passing
        // truncation via providerOptions. Safe because it only targets the
        // OpenAI Responses endpoint and leaves other providers untouched.
        // Can be disabled via muxProviderOptions for testing purposes.
        const disableAutoTruncation = muxProviderOptions?.openai?.disableAutoTruncation ?? false;
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

              const body = init?.body;
              if (
                !disableAutoTruncation &&
                isOpenAIResponses &&
                method === "POST" &&
                typeof body === "string"
              ) {
                // Clone headers to avoid mutating caller-provided objects
                const headers = new Headers(init?.headers);
                // Remove content-length if present, since body will change
                headers.delete("content-length");

                try {
                  const json = JSON.parse(body) as Record<string, unknown>;
                  // Only set if not already present
                  if (json.truncation === undefined) {
                    json.truncation = "auto";
                  }
                  const newBody = JSON.stringify(json);
                  const newInit: RequestInit = { ...init, headers, body: newBody };
                  return baseFetch(input, newInit);
                } catch {
                  // If body isn't JSON, fall through to normal fetch
                  return baseFetch(input, init);
                }
              }

              // Default passthrough
              return baseFetch(input, init);
            } catch {
              // On any unexpected error, fall back to original fetch
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
          ...providerConfig,
          // Cast is safe: our fetch implementation is compatible with the SDK's fetch type.
          // The preconnect method is optional in our implementation but required by the SDK type.
          fetch: fetchWithOpenAITruncation as typeof fetch,
        });
        // Use Responses API for persistence and built-in tools
        // OpenAI manages reasoning state via previousResponseId - no middleware needed
        const model = provider.responses(modelId);
        return Ok(model);
      }

      // Handle xAI provider
      if (providerName === "xai") {
        if (!providerConfig.apiKey) {
          return Err({
            type: "api_key_not_found",
            provider: providerName,
          });
        }

        const baseFetch = getProviderFetch(providerConfig);
        const { apiKey, baseURL, headers, ...extraOptions } = providerConfig;

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
          apiKey,
          baseURL,
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
        if (!providerConfig.apiKey) {
          return Err({
            type: "api_key_not_found",
            provider: providerName,
          });
        }
        const baseFetch = getProviderFetch(providerConfig);

        // Extract standard provider settings (apiKey, baseUrl, headers, fetch)
        const { apiKey, baseUrl, headers, fetch: _fetch, ...extraOptions } = providerConfig;

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
          apiKey,
          baseURL: baseUrl,
          headers,
          fetch: baseFetch,
          extraBody,
        });
        return Ok(provider(modelId));
      }

      // Handle Amazon Bedrock provider
      if (providerName === "bedrock") {
        // Bedrock requires a region - check config or environment
        // Support AWS_REGION (standard) and AWS_DEFAULT_REGION (used by AWS CLI profiles)
        const configRegion = providerConfig.region;
        const region =
          typeof configRegion === "string" && configRegion
            ? configRegion
            : (process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION);

        if (!region) {
          return Err({
            type: "api_key_not_found",
            provider: providerName,
          });
        }

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
          credentialProvider: fromNodeProviderChain(),
          fetch: baseFetch,
        });
        return Ok(provider(modelId));
      }

      // Handle Mux Gateway provider
      if (providerName === "mux-gateway") {
        // Mux Gateway uses couponCode as the API key (fallback to legacy voucher)
        const couponCode = providerConfig.couponCode ?? providerConfig.voucher;
        if (typeof couponCode !== "string" || !couponCode) {
          return Err({
            type: "api_key_not_found",
            provider: providerName,
          });
        }

        const { createGateway } = await PROVIDER_REGISTRY["mux-gateway"]();
        // For Anthropic models via gateway, wrap fetch to inject cache_control on tools
        // (gateway provider doesn't process providerOptions.anthropic.cacheControl)
        // Use getProviderFetch to preserve any user-configured custom fetch (e.g., proxies)
        const baseFetch = getProviderFetch(providerConfig);
        const isAnthropicModel = modelId.startsWith("anthropic/");
        const fetchWithCacheControl = isAnthropicModel
          ? wrapFetchWithAnthropicCacheControl(baseFetch)
          : baseFetch;
        // Use configured baseURL or fall back to default gateway URL
        const gatewayBaseURL =
          providerConfig.baseURL ?? "https://gateway.mux.coder.com/api/v1/ai-gateway/v1/ai";
        const gateway = createGateway({
          apiKey: couponCode,
          baseURL: gatewayBaseURL,
          fetch: fetchWithCacheControl,
        });
        return Ok(gateway(modelId));
      }

      // Generic handler for simple providers (standard API key + factory pattern)
      // Providers with custom logic (anthropic, openai, xai, ollama, openrouter, bedrock, mux-gateway)
      // are handled explicitly above. New providers using the standard pattern need only be
      // added to PROVIDER_DEFINITIONS - no code changes required here.
      const providerDef = PROVIDER_DEFINITIONS[providerName as ProviderName];
      if (providerDef) {
        // Check API key requirement
        if (providerDef.requiresApiKey && !providerConfig.apiKey) {
          return Err({
            type: "api_key_not_found",
            provider: providerName,
          });
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

        const provider = factory({
          ...providerConfig,
          fetch: getProviderFetch(providerConfig),
        });
        return Ok(provider(modelId));
      }

      return Err({
        type: "provider_not_supported",
        provider: providerName,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return Err({ type: "unknown", raw: `Failed to create model: ${errorMessage}` });
    }
  }

  /**
   * Stream a message conversation to the AI model
   * @param messages Array of conversation messages
   * @param workspaceId Unique identifier for the workspace
   * @param modelString Model string (e.g., "anthropic:claude-opus-4-1") - required from frontend
   * @param thinkingLevel Optional thinking/reasoning level for AI models
   * @param toolPolicy Optional policy to filter available tools
   * @param abortSignal Optional signal to abort the stream
   * @param additionalSystemInstructions Optional additional system instructions to append
   * @param maxOutputTokens Optional maximum tokens for model output
   * @param muxProviderOptions Optional provider-specific options
   * @param mode Optional mode name - affects system message via Mode: sections in AGENTS.md
   * @param recordFileState Optional callback to record file state for external edit detection
   * @param changedFileAttachments Optional attachments for files that were edited externally
   * @param postCompactionAttachments Optional attachments to inject after compaction
   * @returns Promise that resolves when streaming completes or fails
   */
  async streamMessage(
    messages: MuxMessage[],
    workspaceId: string,
    modelString: string,
    thinkingLevel?: ThinkingLevel,
    toolPolicy?: ToolPolicy,
    abortSignal?: AbortSignal,
    additionalSystemInstructions?: string,
    maxOutputTokens?: number,
    muxProviderOptions?: MuxProviderOptions,
    mode?: string,
    recordFileState?: (filePath: string, state: FileState) => void,
    changedFileAttachments?: EditedFileAttachment[],
    postCompactionAttachments?: PostCompactionAttachment[] | null
  ): Promise<Result<void, SendMessageError>> {
    try {
      if (this.mockModeEnabled && this.mockScenarioPlayer) {
        return await this.mockScenarioPlayer.play(messages, workspaceId);
      }

      // DEBUG: Log streamMessage call
      const lastMessage = messages[messages.length - 1];
      log.debug(
        `[STREAM MESSAGE] workspaceId=${workspaceId} messageCount=${messages.length} lastRole=${lastMessage?.role}`
      );

      // Before starting a new stream, commit any existing partial to history
      // This is idempotent - won't double-commit if already in chat.jsonl
      await this.partialService.commitToHistory(workspaceId);

      const effectiveMuxProviderOptions: MuxProviderOptions = muxProviderOptions ?? {};

      // For xAI models, swap between reasoning and non-reasoning variants based on thinkingLevel
      // Similar to how OpenAI handles reasoning vs non-reasoning models
      let effectiveModelString = modelString;
      const [providerName, modelId] = parseModelString(modelString);
      if (providerName === "xai" && modelId === "grok-4-1-fast") {
        // xAI Grok only supports full reasoning (no medium/low)
        // Map to appropriate variant based on thinking level
        if (thinkingLevel && thinkingLevel !== "off") {
          effectiveModelString = "xai:grok-4-1-fast-reasoning";
        } else {
          effectiveModelString = "xai:grok-4-1-fast-non-reasoning";
        }
        log.debug("Mapping xAI Grok model to variant", {
          original: modelString,
          effective: effectiveModelString,
          thinkingLevel,
        });
      }

      // Create model instance with early API key validation
      const modelResult = await this.createModel(effectiveModelString, effectiveMuxProviderOptions);
      if (!modelResult.success) {
        return Err(modelResult.error);
      }

      // Dump original messages for debugging
      log.debug_obj(`${workspaceId}/1_original_messages.json`, messages);

      // Use the provider name already extracted above (providerName variable)

      // Get tool names early for mode transition sentinel (stub config, no workspace context needed)
      const earlyRuntime = createRuntime({ type: "local", srcBaseDir: process.cwd() });
      const earlyAllTools = await getToolsForModel(
        modelString,
        {
          cwd: process.cwd(),
          runtime: earlyRuntime,
          runtimeTempDir: os.tmpdir(),
          secrets: {},
        },
        "", // Empty workspace ID for early stub config
        this.initStateManager,
        undefined,
        undefined
      );
      const earlyTools = applyToolPolicy(earlyAllTools, toolPolicy);
      const toolNamesForSentinel = Object.keys(earlyTools);

      // Filter out assistant messages with only reasoning (no text/tools)
      // EXCEPTION: When extended thinking is enabled, preserve reasoning-only messages
      // to comply with Extended Thinking API requirements
      const preserveReasoningOnly = Boolean(thinkingLevel);
      const filteredMessages = filterEmptyAssistantMessages(messages, preserveReasoningOnly);
      log.debug(`Filtered ${messages.length - filteredMessages.length} empty assistant messages`);
      log.debug_obj(`${workspaceId}/1a_filtered_messages.json`, filteredMessages);

      // OpenAI-specific: Keep reasoning parts in history
      // OpenAI manages conversation state via previousResponseId
      if (providerName === "openai") {
        log.debug("Keeping reasoning parts for OpenAI (managed via previousResponseId)");
      }

      // Add [CONTINUE] sentinel to partial messages (for model context)
      const messagesWithSentinel = addInterruptedSentinel(filteredMessages);

      // Note: Further message processing (mode transition, file changes, etc.) happens
      // after runtime is created below, as we need runtime to read the plan file

      // Get workspace metadata to retrieve workspace path
      const metadataResult = await this.getWorkspaceMetadata(workspaceId);
      if (!metadataResult.success) {
        return Err({ type: "unknown", raw: metadataResult.error });
      }

      const metadata = metadataResult.data;

      // Get actual workspace path from config (handles both legacy and new format)
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err({ type: "unknown", raw: `Workspace ${workspaceId} not found in config` });
      }

      // Get workspace path - handle both worktree and in-place modes
      const runtime = createRuntime(
        metadata.runtimeConfig ?? { type: "local", srcBaseDir: this.config.srcDir },
        { projectPath: metadata.projectPath }
      );
      // In-place workspaces (CLI/benchmarks) have projectPath === name
      // Use path directly instead of reconstructing via getWorkspacePath
      const isInPlace = metadata.projectPath === metadata.name;
      const workspacePath = isInPlace
        ? metadata.projectPath
        : runtime.getWorkspacePath(metadata.projectPath, metadata.name);

      // Fetch MCP server config for system prompt (before building message)
      const mcpServers = this.mcpServerManager
        ? await this.mcpServerManager.listServers(metadata.projectPath)
        : undefined;

      // Construct plan mode instruction if in plan mode
      // This is done backend-side because we have access to the plan file path
      let effectiveAdditionalInstructions = additionalSystemInstructions;
      const planFilePath = getPlanFilePath(metadata.name, metadata.projectName);

      // Read plan file (handles legacy migration transparently)
      const planResult = await readPlanFile(
        runtime,
        metadata.name,
        metadata.projectName,
        workspaceId
      );

      if (mode === "plan") {
        const planModeInstruction = getPlanModeInstruction(planFilePath, planResult.exists);
        effectiveAdditionalInstructions = additionalSystemInstructions
          ? `${planModeInstruction}\n\n${additionalSystemInstructions}`
          : planModeInstruction;
      }

      // Read plan content for mode transition (plan → exec)
      // Only read if switching to exec mode and last assistant was in plan mode
      let planContentForTransition: string | undefined;
      if (mode === "exec") {
        const lastAssistantMessage = [...filteredMessages]
          .reverse()
          .find((m) => m.role === "assistant");
        if (lastAssistantMessage?.metadata?.mode === "plan" && planResult.content.trim()) {
          planContentForTransition = planResult.content;
        }
      }

      // Now inject mode transition context with plan content (runtime is now available)
      const messagesWithModeContext = injectModeTransition(
        messagesWithSentinel,
        mode,
        toolNamesForSentinel,
        planContentForTransition
      );

      // Inject file change notifications as user messages (preserves system message cache)
      const messagesWithFileChanges = injectFileChangeNotifications(
        messagesWithModeContext,
        changedFileAttachments
      );

      // Inject post-compaction attachments (plan file, edited files) after compaction summary
      const messagesWithPostCompaction = injectPostCompactionAttachments(
        messagesWithFileChanges,
        postCompactionAttachments
      );

      // Apply centralized tool-output redaction BEFORE converting to provider ModelMessages
      // This keeps the persisted/UI history intact while trimming heavy fields for the request
      const redactedForProvider = applyToolOutputRedaction(messagesWithPostCompaction);
      log.debug_obj(`${workspaceId}/2a_redacted_messages.json`, redactedForProvider);

      // Sanitize tool inputs to ensure they are valid objects (not strings or arrays)
      // This fixes cases where corrupted data in history has malformed tool inputs
      // that would cause API errors like "Input should be a valid dictionary"
      const sanitizedMessages = sanitizeToolInputs(redactedForProvider);
      log.debug_obj(`${workspaceId}/2b_sanitized_messages.json`, sanitizedMessages);

      // Convert MuxMessage to ModelMessage format using Vercel AI SDK utility
      // Type assertion needed because MuxMessage has custom tool parts for interrupted tools
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      const modelMessages = convertToModelMessages(sanitizedMessages as any, {
        // Drop unfinished tool calls (input-streaming/input-available) so downstream
        // transforms only see tool calls that actually produced outputs.
        ignoreIncompleteToolCalls: true,
      });
      log.debug_obj(`${workspaceId}/2_model_messages.json`, modelMessages);

      // Apply ModelMessage transforms based on provider requirements
      const transformedMessages = transformModelMessages(modelMessages, providerName);

      // Apply cache control for Anthropic models AFTER transformation
      const finalMessages = applyCacheControl(transformedMessages, modelString);
      log.debug_obj(`${workspaceId}/3_final_messages.json`, finalMessages);

      // Validate the messages meet Anthropic requirements (Anthropic only)
      if (providerName === "anthropic") {
        const validation = validateAnthropicCompliance(finalMessages);
        if (!validation.valid) {
          log.error(
            `Anthropic compliance validation failed: ${validation.error ?? "unknown error"}`
          );
          // Continue anyway, as the API might be more lenient
        }
      }

      // Build system message from workspace metadata
      const systemMessage = await buildSystemMessage(
        metadata,
        runtime,
        workspacePath,
        mode,
        effectiveAdditionalInstructions,
        modelString,
        mcpServers
      );

      // Count system message tokens for cost tracking
      const tokenizer = await getTokenizerForModel(modelString);
      const systemMessageTokens = await tokenizer.countTokens(systemMessage);

      // Load project secrets
      const projectSecrets = this.config.getProjectSecrets(metadata.projectPath);

      // Generate stream token and create temp directory for tools
      const streamToken = this.streamManager.generateStreamToken();
      let mcpTools: Record<string, Tool> | undefined;
      if (this.mcpServerManager) {
        try {
          mcpTools = await this.mcpServerManager.getToolsForWorkspace({
            workspaceId,
            projectPath: metadata.projectPath,
            runtime,
            workspacePath,
          });
        } catch (error) {
          log.error("Failed to start MCP servers", { workspaceId, error });
        }
      }

      const runtimeTempDir = await this.streamManager.createTempDirForStream(streamToken, runtime);

      // Extract tool-specific instructions from AGENTS.md files
      const toolInstructions = await readToolInstructions(
        metadata,
        runtime,
        workspacePath,
        modelString
      );

      // Get model-specific tools with workspace path (correct for local or remote)
      const allTools = await getToolsForModel(
        modelString,
        {
          cwd: workspacePath,
          runtime,
          secrets: secretsToRecord(projectSecrets),
          muxEnv: getMuxEnv(
            metadata.projectPath,
            getRuntimeType(metadata.runtimeConfig),
            metadata.name
          ),
          runtimeTempDir,
          backgroundProcessManager: this.backgroundProcessManager,
          // Plan mode configuration for path enforcement
          mode: mode as UIMode | undefined,
          planFilePath: mode === "plan" ? planFilePath : undefined,
          workspaceId,
          // External edit detection callback
          recordFileState,
        },
        workspaceId,
        this.initStateManager,
        toolInstructions,
        mcpTools
      );

      // Apply tool policy to filter tools (if policy provided)
      const tools = applyToolPolicy(allTools, toolPolicy);

      log.info("AIService.streamMessage: tool configuration", {
        workspaceId,
        model: modelString,
        toolNames: Object.keys(tools),
        hasToolPolicy: Boolean(toolPolicy),
      });

      // Create assistant message placeholder with historySequence from backend
      const assistantMessageId = `assistant-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
      const assistantMessage = createMuxMessage(assistantMessageId, "assistant", "", {
        timestamp: Date.now(),
        model: modelString,
        systemMessageTokens,
        mode, // Track the mode for this assistant response
      });

      // Append to history to get historySequence assigned
      const appendResult = await this.historyService.appendToHistory(workspaceId, assistantMessage);
      if (!appendResult.success) {
        return Err({ type: "unknown", raw: appendResult.error });
      }

      // Get the assigned historySequence
      const historySequence = assistantMessage.metadata?.historySequence ?? 0;

      const forceContextLimitError =
        modelString.startsWith("openai:") &&
        effectiveMuxProviderOptions.openai?.forceContextLimitError === true;
      const simulateToolPolicyNoop =
        modelString.startsWith("openai:") &&
        effectiveMuxProviderOptions.openai?.simulateToolPolicyNoop === true;

      if (forceContextLimitError) {
        const errorMessage =
          "Context length exceeded: the conversation is too long to send to this OpenAI model. Please shorten the history and try again.";

        const errorPartialMessage: MuxMessage = {
          id: assistantMessageId,
          role: "assistant",
          metadata: {
            historySequence,
            timestamp: Date.now(),
            model: modelString,
            systemMessageTokens,
            partial: true,
            error: errorMessage,
            errorType: "context_exceeded",
          },
          parts: [],
        };

        await this.partialService.writePartial(workspaceId, errorPartialMessage);

        const streamStartEvent: StreamStartEvent = {
          type: "stream-start",
          workspaceId,
          messageId: assistantMessageId,
          model: modelString,
          historySequence,
        };
        this.emit("stream-start", streamStartEvent);

        this.emit("error", {
          type: "error",
          workspaceId,
          messageId: assistantMessageId,
          error: errorMessage,
          errorType: "context_exceeded",
        });

        return Ok(undefined);
      }

      if (simulateToolPolicyNoop) {
        const noopMessage = createMuxMessage(assistantMessageId, "assistant", "", {
          timestamp: Date.now(),
          model: modelString,
          systemMessageTokens,
          toolPolicy,
        });

        const parts: StreamEndEvent["parts"] = [
          {
            type: "text",
            text: "Tool execution skipped because the requested tool is disabled by policy.",
          },
        ];

        const streamStartEvent: StreamStartEvent = {
          type: "stream-start",
          workspaceId,
          messageId: assistantMessageId,
          model: modelString,
          historySequence,
        };
        this.emit("stream-start", streamStartEvent);

        const textParts = parts.filter((part): part is MuxTextPart => part.type === "text");
        if (textParts.length === 0) {
          throw new Error("simulateToolPolicyNoop requires at least one text part");
        }

        for (const textPart of textParts) {
          if (textPart.text.length === 0) {
            continue;
          }

          const streamDeltaEvent: StreamDeltaEvent = {
            type: "stream-delta",
            workspaceId,
            messageId: assistantMessageId,
            delta: textPart.text,
            tokens: 0, // Mock scenario - actual tokenization happens in streamManager
            timestamp: Date.now(),
          };
          this.emit("stream-delta", streamDeltaEvent);
        }

        const streamEndEvent: StreamEndEvent = {
          type: "stream-end",
          workspaceId,
          messageId: assistantMessageId,
          metadata: {
            model: modelString,
            systemMessageTokens,
          },
          parts,
        };
        this.emit("stream-end", streamEndEvent);

        const finalAssistantMessage: MuxMessage = {
          ...noopMessage,
          metadata: {
            ...noopMessage.metadata,
            historySequence,
          },
          parts,
        };

        await this.partialService.deletePartial(workspaceId);
        await this.historyService.updateHistory(workspaceId, finalAssistantMessage);
        return Ok(undefined);
      }

      // Build provider options based on thinking level and message history
      // Pass filtered messages so OpenAI can extract previousResponseId for persistence
      // Also pass callback to filter out lost responseIds (OpenAI invalidated them)
      const providerOptions = buildProviderOptions(
        modelString,
        thinkingLevel ?? "off",
        filteredMessages,
        (id) => this.streamManager.isResponseIdLost(id),
        effectiveMuxProviderOptions
      );

      // Debug dump: Log the complete LLM request when MUX_DEBUG_LLM_REQUEST is set
      // This helps diagnose issues with system prompts, messages, tools, etc.
      if (process.env.MUX_DEBUG_LLM_REQUEST === "1") {
        const llmRequest = {
          workspaceId,
          model: modelString,
          systemMessage,
          messages: finalMessages,
          tools: Object.fromEntries(
            Object.entries(tools).map(([name, tool]) => [
              name,
              {
                description: tool.description,
                inputSchema: tool.inputSchema,
              },
            ])
          ),
          providerOptions,
          thinkingLevel,
          maxOutputTokens,
          mode,
          toolPolicy,
        };
        log.info(
          `[MUX_DEBUG_LLM_REQUEST] Full LLM request:\n${JSON.stringify(llmRequest, null, 2)}`
        );
      }

      // Delegate to StreamManager with model instance, system message, tools, historySequence, and initial metadata
      const streamResult = await this.streamManager.startStream(
        workspaceId,
        finalMessages,
        modelResult.data,
        modelString,
        historySequence,
        systemMessage,
        runtime,
        abortSignal,
        tools,
        {
          systemMessageTokens,
          timestamp: Date.now(),
          mode, // Pass mode so it persists in final history entry
        },
        providerOptions,
        maxOutputTokens,
        toolPolicy,
        streamToken // Pass the pre-generated stream token
      );

      if (!streamResult.success) {
        // StreamManager already returns SendMessageError
        return Err(streamResult.error);
      }

      // StreamManager now handles history updates directly on stream-end
      // No need for event listener here
      return Ok(undefined);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Stream message error:", error);
      // Return as unknown error type
      return Err({ type: "unknown", raw: `Failed to stream message: ${errorMessage}` });
    }
  }

  async stopStream(
    workspaceId: string,
    options?: { soft?: boolean; abandonPartial?: boolean }
  ): Promise<Result<void>> {
    if (this.mockModeEnabled && this.mockScenarioPlayer) {
      this.mockScenarioPlayer.stop(workspaceId);
      return Ok(undefined);
    }
    return this.streamManager.stopStream(workspaceId, options);
  }

  /**
   * Check if a workspace is currently streaming
   */
  isStreaming(workspaceId: string): boolean {
    if (this.mockModeEnabled && this.mockScenarioPlayer) {
      return this.mockScenarioPlayer.isStreaming(workspaceId);
    }
    return this.streamManager.isStreaming(workspaceId);
  }

  /**
   * Get the current stream state for a workspace
   */
  getStreamState(workspaceId: string): string {
    if (this.mockModeEnabled && this.mockScenarioPlayer) {
      return this.mockScenarioPlayer.isStreaming(workspaceId) ? "streaming" : "idle";
    }
    return this.streamManager.getStreamState(workspaceId);
  }

  /**
   * Get the current stream info for a workspace if actively streaming
   * Used to re-establish streaming context on frontend reconnection
   */
  getStreamInfo(workspaceId: string): ReturnType<typeof this.streamManager.getStreamInfo> {
    if (this.mockModeEnabled && this.mockScenarioPlayer) {
      return undefined;
    }
    return this.streamManager.getStreamInfo(workspaceId);
  }

  /**
   * Replay stream events
   * Emits the same events that would be emitted during live streaming
   */
  async replayStream(workspaceId: string): Promise<void> {
    if (this.mockModeEnabled && this.mockScenarioPlayer) {
      await this.mockScenarioPlayer.replayStream(workspaceId);
      return;
    }
    await this.streamManager.replayStream(workspaceId);
  }

  /**
   * DEBUG ONLY: Trigger an artificial stream error for testing.
   * This is used by integration tests to simulate network errors mid-stream.
   * @returns true if an active stream was found and error was triggered
   */
  debugTriggerStreamError(
    workspaceId: string,
    errorMessage = "Test-triggered stream error"
  ): Promise<boolean> {
    return this.streamManager.debugTriggerStreamError(workspaceId, errorMessage);
  }

  async deleteWorkspace(workspaceId: string): Promise<Result<void>> {
    try {
      const workspaceDir = this.config.getSessionDir(workspaceId);
      await fs.rm(workspaceDir, { recursive: true, force: true });
      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to delete workspace: ${message}`);
    }
  }
}
