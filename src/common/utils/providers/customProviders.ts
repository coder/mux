import {
  PROVIDER_DISPLAY_NAMES,
  SUPPORTED_PROVIDERS,
  type ProviderName,
} from "@/common/constants/providers";
export type ProvidersConfigWithProviderType = Record<
  string,
  (object & { providerType?: "openai-compatible" }) | undefined
>;

export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export type CustomProviderIdValidationResult = { ok: true } | { ok: false; reason: string };

const RESERVED_CUSTOM_PROVIDER_IDS = new Set<string>([
  "__proto__",
  "prototype",
  "constructor",
  "hasOwnProperty",
]);

const SUPPORTED_PROVIDER_NAMES: ReadonlySet<string> = new Set(SUPPORTED_PROVIDERS);
const FORBIDDEN_CUSTOM_PROVIDER_ID_CHARS = /[.:/\s]/;

export function isBuiltInProvider(provider: string): provider is ProviderName {
  return SUPPORTED_PROVIDER_NAMES.has(provider);
}

export function validateCustomProviderId(id: string): CustomProviderIdValidationResult {
  if (id.length === 0) {
    return { ok: false, reason: "Custom provider id is required." };
  }

  if (RESERVED_CUSTOM_PROVIDER_IDS.has(id)) {
    return { ok: false, reason: `Custom provider id "${id}" is reserved.` };
  }

  if (isBuiltInProvider(id)) {
    return { ok: false, reason: `Custom provider id "${id}" conflicts with a built-in provider.` };
  }

  if (FORBIDDEN_CUSTOM_PROVIDER_ID_CHARS.test(id)) {
    return {
      ok: false,
      reason: 'Custom provider id must not contain ".", ":", "/", or whitespace.',
    };
  }

  if (!CUSTOM_PROVIDER_ID_PATTERN.test(id)) {
    return {
      ok: false,
      reason:
        "Custom provider id must start with a lowercase letter or digit and contain only lowercase letters, digits, underscores, and hyphens.",
    };
  }

  return { ok: true };
}

export function isValidCustomProviderId(id: string): boolean {
  return validateCustomProviderId(id).ok;
}

export function isCustomOpenAICompatibleProviderConfig(config: unknown): boolean {
  return (
    typeof config === "object" &&
    config !== null &&
    !Array.isArray(config) &&
    (config as { providerType?: unknown }).providerType === "openai-compatible"
  );
}

export function getCustomOpenAICompatibleProviderIds(
  providersConfig: ProvidersConfigWithProviderType
): string[] {
  const providerIds: string[] = [];

  for (const [provider, config] of Object.entries(providersConfig)) {
    if (!isCustomOpenAICompatibleProviderConfig(config)) {
      continue;
    }

    providerIds.push(provider);
  }

  return providerIds;
}

export function getShadowedCustomOpenAICompatibleProviderIds(
  providersConfig: ProvidersConfigWithProviderType
): string[] {
  return getCustomOpenAICompatibleProviderIds(providersConfig).filter(isBuiltInProvider);
}

export function formatProviderDisplayName(
  provider: string,
  config?: { displayName?: string; providerType?: "openai-compatible" }
): string {
  // Manual providers.jsonc edits can shadow a built-in provider id, so prefer
  // the custom OpenAI-compatible display name before consulting built-in names.
  if (config?.providerType === "openai-compatible" && config.displayName) {
    return config.displayName;
  }

  if (isBuiltInProvider(provider)) {
    return PROVIDER_DISPLAY_NAMES[provider];
  }

  // Empty custom display names should fall back to the provider id.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  return config?.displayName || provider;
}
