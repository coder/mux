import {
  STANDARD_MODEL_PARAMETER_TO_CALL_SETTING,
  StandardModelParameterOverridesSchema,
  type ResolvedCallSettingsOverrides,
} from "@/common/config/schemas/modelParameters";
import type { ProvidersConfig } from "@/common/config/schemas/providersConfig";
import { getModelName } from "@/common/utils/ai/models";

export interface ResolvedModelParameterOverrides {
  standard: ResolvedCallSettingsOverrides;
  providerExtras?: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Resolves model parameter overrides from providers.jsonc config.
 *
 * Lookup order (first match wins):
 *   effectiveModelId → canonicalModelId → "*" (wildcard)
 *
 * Standard keys (max_output_tokens, temperature, etc.) are mapped to AI SDK
 * CallSettings names. Unknown keys are returned as providerExtras for merging
 * into providerOptions.
 */
export function resolveModelParameterOverrides(
  providersConfig: ProvidersConfig | null,
  canonicalProviderName: string,
  canonicalModelString: string,
  effectiveModelString?: string
): ResolvedModelParameterOverrides {
  if (!providersConfig) {
    return { standard: {} };
  }

  const providerBlock = providersConfig[canonicalProviderName];
  const modelParams = (providerBlock as Record<string, unknown> | undefined)?.modelParameters as
    | Record<string, unknown>
    | undefined;

  if (!modelParams) {
    return { standard: {} };
  }

  const canonicalModelId = getModelName(canonicalModelString);
  const effectiveModelId =
    effectiveModelString != null ? getModelName(effectiveModelString) : undefined;

  // Build candidates in precedence order; pick the first that is a valid plain object.
  // Malformed entries (strings, arrays, numbers) are silently skipped so the resolver
  // falls through to the next candidate rather than iterating junk.
  const candidates: unknown[] = [
    effectiveModelId != null && effectiveModelId !== canonicalModelId
      ? modelParams[effectiveModelId]
      : undefined,
    modelParams[canonicalModelId],
    modelParams["*"],
  ];

  const entry = candidates.find(isPlainObject);
  if (!entry) {
    return { standard: {} };
  }

  const standard: Record<string, number> = {};
  const providerExtras: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(entry)) {
    if (Object.hasOwn(STANDARD_MODEL_PARAMETER_TO_CALL_SETTING, key)) {
      const standardKey = key as keyof typeof STANDARD_MODEL_PARAMETER_TO_CALL_SETTING;
      const sdkKey = STANDARD_MODEL_PARAMETER_TO_CALL_SETTING[standardKey];

      // Config may be hand-edited; validate each standard key against schema bounds defensively.
      const validator = StandardModelParameterOverridesSchema.shape[standardKey];
      const parsed = validator.safeParse(value);
      if (parsed.success && parsed.data !== undefined) {
        standard[sdkKey] = parsed.data;
      }
      continue;
    }

    providerExtras[key] = value;
  }

  return {
    standard: standard as ResolvedCallSettingsOverrides,
    ...(Object.keys(providerExtras).length > 0 ? { providerExtras } : {}),
  };
}
