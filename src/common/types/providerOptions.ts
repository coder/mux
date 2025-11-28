import type { XaiProviderOptions } from "@ai-sdk/xai";

/**
 * Mux provider-specific options that get passed through the stack.
 * Used by both frontend and backend to configure provider-specific features
 * without polluting function signatures with individual flags.
 *
 * Note: This is separate from the AI SDK's provider options
 * (src/utils/ai/providerOptions.ts) which configures thinking levels, etc.
 * These options configure features that need to be applied at the provider
 * configuration level (e.g., custom headers, beta features).
 */

/**
 * Anthropic-specific options
 */
export interface AnthropicProviderOptions {
  /** Enable 1M context window (requires beta header) */
  use1MContext?: boolean;
}

/**
 * OpenAI-specific options
 */
export interface OpenAIProviderOptions {
  /** Disable automatic context truncation (useful for testing) */
  disableAutoTruncation?: boolean;
  /** Force context limit error (used in integration tests to simulate overflow) */
  forceContextLimitError?: boolean;
  /** Simulate successful response without executing tools (used in tool policy tests) */
  simulateToolPolicyNoop?: boolean;
}

/**
 * Google-specific options
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GoogleProviderOptions {}

/**
 * Ollama-specific options
 * Currently empty - Ollama is a local service and doesn't require special options.
 * This interface is provided for future extensibility.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface OllamaProviderOptions {}

/**
 * OpenRouter-specific options
 * Transparently passes through options to the OpenRouter provider
 * @see https://openrouter.ai/docs
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface OpenRouterProviderOptions {}

/**
 * Mux provider options - used by both frontend and backend
 */
/**
 * xAI-specific options
 */
export interface XaiProviderOverrides {
  /** Override Grok search parameters (defaults to auto search with citations) */
  searchParameters?: XaiProviderOptions["searchParameters"];
}

export interface MuxProviderOptions {
  /** Provider-specific options */
  anthropic?: AnthropicProviderOptions;
  openai?: OpenAIProviderOptions;
  google?: GoogleProviderOptions;
  ollama?: OllamaProviderOptions;
  openrouter?: OpenRouterProviderOptions;
  xai?: XaiProviderOverrides;
}
