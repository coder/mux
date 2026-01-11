/**
 * Provider credential resolution - single source of truth for provider authentication.
 *
 * Used by:
 * - providerService.ts: UI status (isConfigured flag for frontend)
 * - aiService.ts: runtime credential resolution before making API calls
 * - CLI bootstrap: buildProvidersFromEnv() to create initial providers.jsonc
 */

import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";
import type { ProviderConfig, ProvidersConfig } from "@/node/config";

// ============================================================================
// Environment variable mappings - single source of truth
// ============================================================================

/** Env var names for each provider credential type (checked in order, first non-empty wins) */
export const PROVIDER_ENV_VARS: Partial<
  Record<
    ProviderName,
    {
      apiKey?: string[];
      baseUrl?: string[];
      organization?: string[];
      region?: string[];
      resource?: string[];
    }
  >
> = {
  anthropic: {
    apiKey: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    baseUrl: ["ANTHROPIC_BASE_URL"],
  },
  "azure-foundry": {
    apiKey: ["AZURE_FOUNDRY_API_KEY", "AZURE_API_KEY"],
    resource: ["AZURE_FOUNDRY_RESOURCE"],
  },
  openai: {
    apiKey: ["OPENAI_API_KEY"],
    baseUrl: ["OPENAI_BASE_URL", "OPENAI_API_BASE"],
    organization: ["OPENAI_ORG_ID"],
  },
  google: {
    apiKey: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
    baseUrl: ["GOOGLE_BASE_URL"],
  },
  xai: {
    apiKey: ["XAI_API_KEY"],
    baseUrl: ["XAI_BASE_URL"],
  },
  openrouter: {
    apiKey: ["OPENROUTER_API_KEY"],
  },
  deepseek: {
    apiKey: ["DEEPSEEK_API_KEY"],
  },
  bedrock: {
    region: ["AWS_REGION", "AWS_DEFAULT_REGION"],
  },
};

/** Azure OpenAI env vars (special case: maps to "openai" provider) */
export const AZURE_OPENAI_ENV_VARS = {
  apiKey: "AZURE_OPENAI_API_KEY",
  endpoint: "AZURE_OPENAI_ENDPOINT",
  deployment: "AZURE_OPENAI_DEPLOYMENT",
  apiVersion: "AZURE_OPENAI_API_VERSION",
};

/** Resolve first non-empty env var from a list of candidates */
function resolveEnv(
  keys: string[] | undefined,
  env: Record<string, string | undefined>
): string | undefined {
  for (const key of keys ?? []) {
    const val = env[key]?.trim();
    if (val) return val;
  }
  return undefined;
}

// ============================================================================
// Types
// ============================================================================

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
  organization?: string; // OpenAI org ID
  resource?: string; // Azure Foundry resource name
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
  baseUrl?: string; // from config or env
  organization?: string; // openai
  resource?: string; // azure-foundry
}

/** Legacy alias for backward compatibility */
export type ProviderConfigCheck = Pick<ResolvedCredentials, "isConfigured" | "missingRequirement">;

// ============================================================================
// Credential resolution
// ============================================================================

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
    const configRegion = typeof config.region === "string" && config.region ? config.region : null;
    const region = configRegion ?? resolveEnv(PROVIDER_ENV_VARS.bedrock?.region, env);
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

  // Azure Foundry: requires both API key and resource name
  if (provider === "azure-foundry") {
    const envMapping = PROVIDER_ENV_VARS[provider];
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string should be treated as unset
    const configKey = config.apiKey || null;
    const apiKey = configKey ?? resolveEnv(envMapping?.apiKey, env);
    const resource = config.resource ?? resolveEnv(envMapping?.resource, env);

    if (apiKey && resource) {
      return { isConfigured: true, apiKey, resource };
    }
    return { isConfigured: false, missingRequirement: "api_key" };
  }

  // Keyless providers (e.g., ollama): require explicit opt-in via baseUrl or models
  const def = PROVIDER_DEFINITIONS[provider];
  if (!def.requiresApiKey) {
    const hasExplicitConfig = Boolean(config.baseUrl ?? (config.models?.length ?? 0) > 0);
    return { isConfigured: hasExplicitConfig };
  }

  // Standard API key providers: check config first, then env vars
  const envMapping = PROVIDER_ENV_VARS[provider];
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string should be treated as unset
  const configKey = config.apiKey || null;
  const apiKey = configKey ?? resolveEnv(envMapping?.apiKey, env);
  const baseUrl = config.baseURL ?? config.baseUrl ?? resolveEnv(envMapping?.baseUrl, env);
  // Config organization takes precedence over env var (user's explicit choice)
  const organization = config.organization ?? resolveEnv(envMapping?.organization, env);

  if (apiKey) {
    return { isConfigured: true, apiKey, baseUrl, organization };
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

// ============================================================================
// Bootstrap: build providers config from environment variables
// ============================================================================

/**
 * Build a ProvidersConfig from environment variables.
 * Used during CLI bootstrap when no providers.jsonc exists.
 *
 * @param env - Environment variables (defaults to process.env)
 * @returns ProvidersConfig with all providers that have credentials in env
 */
export function buildProvidersFromEnv(
  env: Record<string, string | undefined> = process.env
): ProvidersConfig {
  const providers: ProvidersConfig = {};

  // Check each provider that has env var mappings
  for (const provider of Object.keys(PROVIDER_ENV_VARS) as ProviderName[]) {
    // Skip bedrock - it uses AWS credential chain, not simple API key
    if (provider === "bedrock") continue;

    const creds = resolveProviderCredentials(provider, {}, env);
    if (creds.isConfigured && creds.apiKey) {
      const entry: ProviderConfig = { apiKey: creds.apiKey };
      if (creds.baseUrl) entry.baseUrl = creds.baseUrl;
      if (creds.organization) entry.organization = creds.organization;
      providers[provider] = entry;
    }
  }

  // Azure OpenAI special case: maps to "openai" provider if not already set
  if (!providers.openai) {
    const azureKey = env[AZURE_OPENAI_ENV_VARS.apiKey]?.trim();
    const azureEndpoint = env[AZURE_OPENAI_ENV_VARS.endpoint]?.trim();

    if (azureKey && azureEndpoint) {
      const entry: ProviderConfig = {
        apiKey: azureKey,
        baseUrl: azureEndpoint,
      };

      const deployment = env[AZURE_OPENAI_ENV_VARS.deployment]?.trim();
      if (deployment) entry.defaultModel = deployment;

      const apiVersion = env[AZURE_OPENAI_ENV_VARS.apiVersion]?.trim();
      if (apiVersion) entry.apiVersion = apiVersion;

      providers.openai = entry;
    }
  }

  return providers;
}

/**
 * Check if any provider in the config has an API key configured.
 */
export function hasAnyConfiguredProvider(providers: ProvidersConfig | null | undefined): boolean {
  if (!providers) return false;
  return Object.values(providers).some(
    (config) => config && typeof config.apiKey === "string" && config.apiKey.trim().length > 0
  );
}
