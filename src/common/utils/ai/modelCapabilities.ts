import modelsData from "../tokens/models.json";
import { modelsExtra } from "../tokens/models-extra";
import { normalizeGatewayModel } from "./models";

interface RawModelCapabilitiesData {
  supports_pdf_input?: boolean;
  supports_vision?: boolean;
  supports_audio_input?: boolean;
  supports_video_input?: boolean;
  max_pdf_size_mb?: number;
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

  const keys: string[] = [
    modelName, // Direct model name (e.g., "claude-opus-4-5")
  ];

  if (provider) {
    keys.push(
      `${provider}/${modelName}`, // "ollama/gpt-oss:20b"
      `${provider}/${modelName}-cloud` // "ollama/gpt-oss:20b-cloud" (LiteLLM convention)
    );

    // Fallback: strip size suffix for base model lookup
    // "ollama:gpt-oss:20b" → "ollama/gpt-oss"
    if (modelName.includes(":")) {
      const baseModel = modelName.split(":")[0];
      keys.push(`${provider}/${baseModel}`);
    }
  }

  return keys;
}

function extractModelCapabilities(data: RawModelCapabilitiesData): ModelCapabilities {
  const maxPdfSizeMb = typeof data.max_pdf_size_mb === "number" ? data.max_pdf_size_mb : undefined;

  return {
    // Some providers omit supports_pdf_input but still include a max_pdf_size_mb field.
    // Treat maxPdfSizeMb as a strong signal that PDF input is supported.
    supportsPdfInput: data.supports_pdf_input === true || maxPdfSizeMb !== undefined,
    supportsVision: data.supports_vision === true,
    supportsAudioInput: data.supports_audio_input === true,
    supportsVideoInput: data.supports_video_input === true,
    maxPdfSizeMb,
  };
}

export function getModelCapabilities(modelString: string): ModelCapabilities | null {
  const normalized = normalizeGatewayModel(modelString);
  const lookupKeys = generateLookupKeys(normalized);

  const modelsExtraRecord = modelsExtra as unknown as Record<string, RawModelCapabilitiesData>;
  const modelsDataRecord = modelsData as unknown as Record<string, RawModelCapabilitiesData>;

  // Merge models.json (upstream) + models-extra.ts (local overrides). Extras win.
  // This avoids wiping capabilities (e.g. PDF support) when modelsExtra only overrides
  // pricing/token limits.
  for (const key of lookupKeys) {
    const base = modelsDataRecord[key];
    const extra = modelsExtraRecord[key];

    if (base || extra) {
      const merged: RawModelCapabilitiesData = { ...(base ?? {}), ...(extra ?? {}) };
      return extractModelCapabilities(merged);
    }
  }

  return null;
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
