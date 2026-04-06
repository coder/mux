import type { ProvidersConfigWithModels } from "@/common/utils/providers/modelEntries";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import modelsData from "../tokens/models.json";
import { modelsExtra } from "../tokens/models-extra";
import { normalizeToCanonical } from "./models";

interface RawModelCapabilitiesData {
  supports_pdf_input?: boolean;
  supports_vision?: boolean;
  supports_audio_input?: boolean;
  supports_video_input?: boolean;
  max_pdf_size_mb?: number;
  litellm_provider?: string;
  supported_endpoints?: string[];
  [key: string]: unknown;
}

export interface ModelCapabilities {
  supportsPdfInput: boolean;
  supportsVision: boolean;
  supportsAudioInput: boolean;
  supportsVideoInput: boolean;
  maxPdfSizeMb?: number;
}

export type SupportedInputMediaType = "image" | "pdf" | "audio" | "video";

const PROVIDER_KEY_ALIASES: Record<string, string> = {
  // GitHub Copilot keys in models.json use underscores for LiteLLM provider names.
  "github-copilot": "github_copilot",
};

/**
 * Generates lookup keys for a model string with multiple naming patterns.
 *
 * Keep this aligned with getModelStats(): many providers/layers use slightly different
 * conventions (e.g. "ollama/model-cloud", "provider/model").
 */
function generateLookupKeys(modelString: string): string[] {
  const colonIndex = modelString.indexOf(":");
  const provider = colonIndex !== -1 ? modelString.slice(0, colonIndex) : "";
  const modelName = colonIndex !== -1 ? modelString.slice(colonIndex + 1) : modelString;
  const litellmProvider = PROVIDER_KEY_ALIASES[provider] ?? provider;

  const keys: string[] = [];

  if (provider) {
    // Provider-scoped keys first so provider-specific metadata (e.g.
    // `github_copilot/gpt-5.2` restricting `/v1/batch`) wins over the
    // generic bare-model entry.
    keys.push(
      `${litellmProvider}/${modelName}`, // "ollama/gpt-oss:20b"
      `${litellmProvider}/${modelName}-cloud` // "ollama/gpt-oss:20b-cloud" (LiteLLM convention)
    );

    // Fallback: strip size suffix for base model lookup
    // "ollama:gpt-oss:20b" → "ollama/gpt-oss"
    if (modelName.includes(":")) {
      const baseModel = modelName.split(":")[0];
      keys.push(`${litellmProvider}/${baseModel}`);
    }
  }

  // Bare model name is the last-resort fallback.
  keys.push(modelName);

  return keys;
}

function extractModelCapabilities(data: RawModelCapabilitiesData): ModelCapabilities {
  const maxPdfSizeMb = typeof data.max_pdf_size_mb === "number" ? data.max_pdf_size_mb : undefined;
  const provider = typeof data.litellm_provider === "string" ? data.litellm_provider : undefined;

  return {
    // Some providers omit supports_pdf_input but still include a max_pdf_size_mb field.
    // Treat maxPdfSizeMb as a strong signal that PDF input is supported.
    // OpenAI's vision-capable models also accept PDFs, but our local GPT-5 metadata in
    // models-extra.ts currently omits supports_pdf_input. Infer support here so users
    // don't get a false "does not support PDF input" block for models like openai:gpt-5.4.
    supportsPdfInput:
      data.supports_pdf_input === true ||
      maxPdfSizeMb !== undefined ||
      (provider === "openai" && data.supports_vision === true && data.supports_pdf_input !== false),
    supportsVision: data.supports_vision === true,
    supportsAudioInput: data.supports_audio_input === true,
    supportsVideoInput: data.supports_video_input === true,
    maxPdfSizeMb,
  };
}

export function getModelCapabilities(modelString: string): ModelCapabilities | null {
  const normalized = normalizeToCanonical(modelString);
  const lookupKeys = generateLookupKeys(normalized);

  const modelsExtraRecord = modelsExtra as unknown as Record<string, RawModelCapabilitiesData>;
  const modelsDataRecord = modelsData as unknown as Record<string, RawModelCapabilitiesData>;

  // Merge across ALL matching lookup keys so provider-scoped entries (first
  // in lookup order) override specific fields while bare-model entries fill
  // in capabilities the provider-scoped entry omits (e.g. github_copilot/gpt-4o
  // lacks supports_pdf_input but bare gpt-4o has it).
  // Within each key, modelsExtra wins over modelsData (upstream).
  let merged: RawModelCapabilitiesData | null = null;
  for (const key of lookupKeys) {
    const base = modelsDataRecord[key];
    const extra = modelsExtraRecord[key];

    if (base || extra) {
      const keyData: RawModelCapabilitiesData = Object.assign({}, base ?? {}, extra ?? {});
      if (merged != null) {
        // Earlier keys (provider-scoped) take priority; later keys (bare model)
        // fill gaps but don't override.
        merged = Object.assign({}, keyData, merged);
      } else {
        merged = keyData;
      }
    }
  }

  return merged ? extractModelCapabilities(merged) : null;
}

export function getModelCapabilitiesResolved(
  modelString: string,
  providersConfig: ProvidersConfigWithModels | null
): ModelCapabilities | null {
  const metadataModel = resolveModelForMetadata(modelString, providersConfig);
  return getModelCapabilities(metadataModel);
}

export function getSupportedInputMediaTypes(
  modelString: string
): Set<SupportedInputMediaType> | null {
  const caps = getModelCapabilities(modelString);
  if (!caps) return null;

  const result = new Set<SupportedInputMediaType>();
  if (caps.supportsVision) result.add("image");
  if (caps.supportsPdfInput) result.add("pdf");
  if (caps.supportsAudioInput) result.add("audio");
  if (caps.supportsVideoInput) result.add("video");
  return result;
}

/**
 * Resolve supported API endpoints for a model string from static metadata.
 *
 * Returns the `supported_endpoints` array (e.g. `["/v1/responses"]`) when
 * found in models-extra or models.json, or `null` when no metadata exists
 * or the metadata lacks endpoint information.
 */
export function getSupportedEndpoints(modelString: string): string[] | null {
  const normalized = normalizeToCanonical(modelString);
  const lookupKeys = generateLookupKeys(normalized);

  const modelsExtraRecord = modelsExtra as unknown as Record<string, RawModelCapabilitiesData>;
  const modelsDataRecord = modelsData as unknown as Record<string, RawModelCapabilitiesData>;

  for (const key of lookupKeys) {
    const base = modelsDataRecord[key];
    const extra = modelsExtraRecord[key];

    if (base || extra) {
      // Extra wins for the same field; merge so we don't lose base-only endpoints.
      const merged: RawModelCapabilitiesData = { ...(base ?? {}), ...(extra ?? {}) };
      return merged.supported_endpoints ?? null;
    }
  }

  return null;
}

/**
 * Like `getSupportedEndpoints`, but first resolves config aliases
 * (e.g. `mappedToModel`) so gateway-scoped model IDs inherit metadata
 * from the underlying model when the gateway-scoped key has no entry.
 */
export function getSupportedEndpointsResolved(
  modelString: string,
  providersConfig: ProvidersConfigWithModels | null
): string[] | null {
  // Try the raw (possibly gateway-scoped) key first so provider-specific
  // endpoint overrides (e.g. `github_copilot/gpt-5.4`) take priority.
  const direct = getSupportedEndpoints(modelString);
  if (direct != null) {
    return direct;
  }

  // Fall back to the metadata-resolved alias (e.g. mappedToModel) so
  // models without a provider-scoped entry inherit from the bare model.
  const metadataModel = resolveModelForMetadata(modelString, providersConfig);
  if (metadataModel !== modelString) {
    return getSupportedEndpoints(metadataModel);
  }

  return null;
}
