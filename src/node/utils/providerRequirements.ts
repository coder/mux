/**
 * Provider credential resolution - single source of truth for provider authentication.
 *
 * Used by:
 * - providerService.ts: UI status (isConfigured flag for frontend)
 * - aiService.ts: runtime credential resolution before making API calls
 * - CLI bootstrap: buildProvidersFromEnv() to create initial providers.jsonc
 */

import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";
import { isProviderDisabledInConfig } from "@/common/utils/providers/isProviderDisabled";
import type {
  BedrockProviderConfig,
  MuxGatewayProviderConfig,
  OpenAIProviderConfig,
} from "@/common/config/schemas/providersConfig";
import type { ProviderConfig, ProvidersConfig } from "@/node/config";
import { parseCodexOauthAuth } from "@/node/utils/codexOauthAuth";

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
    }
  >
> = {
  anthropic: {
    apiKey: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    baseUrl: ["ANTHROPIC_BASE_URL"],
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
  "github-copilot": {
    apiKey: ["GITHUB_COPILOT_TOKEN"],
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

const BEDROCK_AUTH_ENV_VARS = {
  accessKeyId: "AWS_ACCESS_KEY_ID",
  secretAccessKey: "AWS_SECRET_ACCESS_KEY",
  bearerToken: "AWS_BEARER_TOKEN_BEDROCK",
  profile: "AWS_PROFILE",
} as const;

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

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasCredentialPair(accessKeyId: unknown, secretAccessKey: unknown): boolean {
  return hasNonEmptyString(accessKeyId) && hasNonEmptyString(secretAccessKey);
}

// ============================================================================
// Types
// ============================================================================

type ProviderSpecificCredentialFields = Partial<
  Pick<
    BedrockProviderConfig,
    "region" | "profile" | "bearerToken" | "accessKeyId" | "secretAccessKey"
  > &
    Pick<MuxGatewayProviderConfig, "couponCode" | "voucher"> &
    Pick<OpenAIProviderConfig, "organization">
>;

// Raw provider config as read from disk — before validation.
// Omit enabled/models then re-add with looser types for defensive parsing.
export type ProviderConfigRaw = Omit<ProviderConfig, "enabled" | "models"> & {
  enabled?: unknown;
  models?: unknown[];
} & ProviderSpecificCredentialFields;

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

  // Keyless providers (e.g., ollama): require explicit opt-in via baseUrl or models
  const def = PROVIDER_DEFINITIONS[provider];
  if (!def.requiresApiKey) {
    const hasExplicitConfig = Boolean(config.baseUrl ?? (config.models?.length ?? 0) > 0);
    return { isConfigured: hasExplicitConfig };
  }

  // Standard API key providers: check config first, then env vars
  const envMapping = PROVIDER_ENV_VARS[provider];
  const configKey =
    typeof config.apiKey === "string" && config.apiKey.trim().length > 0 ? config.apiKey : null;
  const apiKey = configKey ?? resolveEnv(envMapping?.apiKey, env);
  const configBaseUrl =
    (typeof config.baseURL === "string" && config.baseURL) ||
    (typeof config.baseUrl === "string" && config.baseUrl) ||
    undefined;
  const baseUrl = configBaseUrl ?? resolveEnv(envMapping?.baseUrl, env);
  // Config organization takes precedence over env var (user's explicit choice)
  const configOrganization =
    typeof config.organization === "string" && config.organization
      ? config.organization
      : undefined;
  const organization = configOrganization ?? resolveEnv(envMapping?.organization, env);

  if (apiKey) {
    return { isConfigured: true, apiKey, baseUrl, organization };
  }

  return { isConfigured: false, missingRequirement: "api_key" };
}

/**
 * Auto-route admission is stricter than general configured-state checks for Bedrock.
 * A region alone is enough to show Bedrock as configured in the UI, but routePriority
 * should only auto-admit it when we can also observe at least one auth signal.
 */
export function isProviderAutoRouteEligible(
  provider: ProviderName,
  config: ProviderConfigRaw,
  env: Record<string, string | undefined> = process.env
): boolean {
  // Keep auto-route admission aligned with runtime availability: saved credentials alone
  // must not reinsert a provider the user has explicitly disabled.
  if (isProviderDisabledInConfig(config)) {
    return false;
  }

  const credentials = resolveProviderCredentials(provider, config, env);
  if (!credentials.isConfigured) {
    return false;
  }

  if (provider !== "bedrock") {
    return true;
  }

  return (
    hasCredentialPair(config.accessKeyId, config.secretAccessKey) ||
    hasNonEmptyString(config.bearerToken) ||
    hasNonEmptyString(config.profile) ||
    hasCredentialPair(
      env[BEDROCK_AUTH_ENV_VARS.accessKeyId],
      env[BEDROCK_AUTH_ENV_VARS.secretAccessKey]
    ) ||
    hasNonEmptyString(env[BEDROCK_AUTH_ENV_VARS.bearerToken]) ||
    hasNonEmptyString(env[BEDROCK_AUTH_ENV_VARS.profile])
  );
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
 * Check whether any provider is configured well enough for the CLI to start.
 *
 * This intentionally mirrors runtime/provider status checks instead of only
 * looking for API keys so keyless providers (e.g. Ollama) and OpenAI Codex
 * OAuth-only setups are treated as valid.
 */
export function hasAnyConfiguredProvider(providers: ProvidersConfig | null | undefined): boolean {
  if (!providers) return false;

  for (const [providerKey, rawConfig] of Object.entries(providers)) {
    if (!rawConfig || typeof rawConfig !== "object") {
      continue;
    }

    // OpenAI Codex OAuth is a valid credential path even without apiKey.
    if (
      providerKey === "openai" &&
      parseCodexOauthAuth((rawConfig as { codexOauth?: unknown }).codexOauth) !== null
    ) {
      return true;
    }

    if (!(providerKey in PROVIDER_DEFINITIONS)) {
      // Be permissive for unknown providers written by future versions.
      const apiKey = (rawConfig as { apiKey?: unknown }).apiKey;
      if (typeof apiKey === "string" && apiKey.trim().length > 0) {
        return true;
      }
      continue;
    }

    if (
      checkProviderConfigured(providerKey as ProviderName, rawConfig as ProviderConfigRaw)
        .isConfigured
    ) {
      return true;
    }
  }

  return false;
}
