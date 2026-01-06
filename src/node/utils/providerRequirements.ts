/**
 * Provider credential resolution - single source of truth for provider authentication.
 *
 * Used by:
 * - providerService.ts: UI status (isConfigured flag for frontend)
 * - aiService.ts: runtime credential resolution before making API calls
 */

import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";

/** Raw provider config shape (subset of providers.jsonc entry) */
export interface ProviderConfigRaw {
  apiKey?: string;
  baseUrl?: string;
  baseURL?: string; // Anthropic uses baseURL
  models?: string[];
  region?: string;
  bearerToken?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  couponCode?: string;
  voucher?: string; // legacy mux-gateway field
}

/** Result of resolving provider credentials */
export interface ResolvedCredentials {
  isConfigured: boolean;
  /** What's missing, if not configured (for error messages) */
  missingRequirement?: "api_key" | "region" | "coupon_code";

  // Resolved credential values - aiService uses these directly
  apiKey?: string; // anthropic, openai, etc.
  region?: string; // bedrock
  couponCode?: string; // mux-gateway
  baseUrl?: string; // anthropic (from env)
}

/** Legacy alias for backward compatibility */
export type ProviderConfigCheck = Pick<ResolvedCredentials, "isConfigured" | "missingRequirement">;

/**
 * Resolve provider credentials from config and environment.
 * Returns both configuration status AND resolved credential values.
 *
 * @param provider - Provider name
 * @param config - Raw config from providers.jsonc (or empty object)
 * @param env - Environment variables (defaults to process.env)
 */
export function resolveProviderCredentials(
  provider: ProviderName,
  config: ProviderConfigRaw,
  env: Record<string, string | undefined> = process.env
): ResolvedCredentials {
  // Bedrock: region required (credentials via AWS SDK chain)
  if (provider === "bedrock") {
    // Check config first, then env vars - empty strings treated as unset
    const configRegion = typeof config.region === "string" && config.region ? config.region : null;
    const region = configRegion ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    return region
      ? { isConfigured: true, region }
      : { isConfigured: false, missingRequirement: "region" };
  }

  // Mux Gateway: coupon code required (no env var support)
  if (provider === "mux-gateway") {
    const couponCode = config.couponCode ?? config.voucher;
    return couponCode
      ? { isConfigured: true, couponCode }
      : { isConfigured: false, missingRequirement: "coupon_code" };
  }

  // Keyless providers (e.g., ollama): require explicit opt-in via baseUrl or models
  // We can't detect if Ollama is running without a network probe, so require config
  const def = PROVIDER_DEFINITIONS[provider];
  if (!def.requiresApiKey) {
    const hasExplicitConfig = Boolean(config.baseUrl ?? (config.models?.length ?? 0) > 0);
    return { isConfigured: hasExplicitConfig };
  }

  // Anthropic: special handling for multiple env vars + base URL from env
  if (provider === "anthropic") {
    // Check config first, then env vars - empty strings treated as unset
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string should be treated as unset
    const configKey = config.apiKey || null;
    const apiKey = configKey ?? env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN;
    const baseUrl = config.baseURL ?? config.baseUrl ?? env.ANTHROPIC_BASE_URL;
    return apiKey
      ? { isConfigured: true, apiKey, baseUrl }
      : { isConfigured: false, missingRequirement: "api_key" };
  }

  // Standard API key providers: config only (no env fallback in aiService)
  if (config.apiKey) {
    return { isConfigured: true, apiKey: config.apiKey };
  }

  return { isConfigured: false, missingRequirement: "api_key" };
}

/**
 * Check if a provider is configured (has necessary credentials).
 * Convenience wrapper around resolveProviderCredentials for UI status checks.
 */
export function checkProviderConfigured(
  provider: ProviderName,
  config: ProviderConfigRaw,
  env: Record<string, string | undefined> = process.env
): ProviderConfigCheck {
  const { isConfigured, missingRequirement } = resolveProviderCredentials(provider, config, env);
  return { isConfigured, missingRequirement };
}
