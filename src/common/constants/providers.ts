/**
 * Typed import helpers for provider packages
 *
 * These functions provide type-safe dynamic imports for provider packages.
 * TypeScript can infer the correct module type from literal string imports,
 * giving consuming code full type safety for provider constructors.
 */

/**
 * Dynamically import the Anthropic provider package
 */
export async function importAnthropic() {
  return await import("@ai-sdk/anthropic");
}

/**
 * Dynamically import the OpenAI provider package
 */
export async function importOpenAI() {
  return await import("@ai-sdk/openai");
}

/**
 * Dynamically import the Ollama provider package
 */
export async function importOllama() {
  return await import("ollama-ai-provider-v2");
}

/**
 * Dynamically import the Google provider package
 */
export async function importGoogle() {
  return await import("@ai-sdk/google");
}

/**
 * Dynamically import the OpenRouter provider package
 */
export async function importOpenRouter() {
  return await import("@openrouter/ai-sdk-provider");
}

/**
 * Dynamically import the xAI provider package
 */
export async function importXAI() {
  return await import("@ai-sdk/xai");
}

/**
 * Centralized provider registry mapping provider names to their import functions
 *
 * This is the single source of truth for supported providers. By mapping to import
 * functions rather than package strings, we eliminate duplication while maintaining
 * perfect type safety.
 *
 * When adding a new provider:
 * 1. Create an importXxx() function above
 * 2. Add entry mapping provider name to the import function
 * 3. Implement provider handling in aiService.ts createModel()
 * 4. Runtime check will fail if provider in registry but no handler
 */
export const PROVIDER_REGISTRY = {
  anthropic: importAnthropic,
  openai: importOpenAI,
  google: importGoogle,
  xai: importXAI,
  ollama: importOllama,
  openrouter: importOpenRouter,
} as const;

/**
 * Union type of all supported provider names
 */
export type ProviderName = keyof typeof PROVIDER_REGISTRY;

/**
 * Array of all supported provider names (for UI lists, iteration, etc.)
 */
export const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_REGISTRY) as ProviderName[];

/**
 * Display names for providers (proper casing for UI)
 */
export const PROVIDER_DISPLAY_NAMES: Record<ProviderName, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  ollama: "Ollama",
  openrouter: "OpenRouter",
};

/**
 * Type guard to check if a string is a valid provider name
 */
export function isValidProvider(provider: string): provider is ProviderName {
  return provider in PROVIDER_REGISTRY;
}
