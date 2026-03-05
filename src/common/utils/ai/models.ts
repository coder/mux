/**
 * Model configuration and constants
 */

import { DEFAULT_MODEL, MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";

export const defaultModel = DEFAULT_MODEL;

/**
 * Resolve model alias to full model string.
 * If the input is an alias (e.g., "haiku", "sonnet"), returns the full model string.
 * Otherwise returns the input unchanged.
 */
export function resolveModelAlias(modelInput: string): string {
  if (Object.hasOwn(MODEL_ABBREVIATIONS, modelInput)) {
    return MODEL_ABBREVIATIONS[modelInput];
  }
  return modelInput;
}

/**
 * Validate model string format (must be "provider:model-id").
 * Supports colons in the model ID (e.g., "ollama:gpt-oss:20b").
 */
export function isValidModelFormat(model: string): boolean {
  const colonIndex = model.indexOf(":");
  return colonIndex > 0 && colonIndex < model.length - 1;
}

const MUX_GATEWAY_PREFIX = "mux-gateway:";

/**
 * Normalize gateway-prefixed model strings to standard format.
 * Converts "mux-gateway:provider/model" to "provider:model".
 * Returns non-gateway strings unchanged.
 */
export function normalizeGatewayModel(modelString: string): string {
  if (!modelString.startsWith(MUX_GATEWAY_PREFIX)) {
    return modelString;
  }
  // mux-gateway:anthropic/claude-opus-4-5 → anthropic:claude-opus-4-5
  const inner = modelString.slice(MUX_GATEWAY_PREFIX.length);
  const slashIndex = inner.indexOf("/");
  if (slashIndex === -1) {
    return modelString; // Malformed, return as-is
  }
  return `${inner.slice(0, slashIndex)}:${inner.slice(slashIndex + 1)}`;
}

/**
 * Extract the model name from a model string (e.g., "anthropic:claude-sonnet-4-5" -> "claude-sonnet-4-5")
 * @param modelString - Full model string in format "provider:model-name"
 * @returns The model name part (after the colon), or the full string if no colon is found
 */
export function getModelName(modelString: string): string {
  const normalized = normalizeGatewayModel(modelString);
  const colonIndex = normalized.indexOf(":");
  if (colonIndex === -1) {
    return normalized;
  }
  return normalized.substring(colonIndex + 1);
}

/**
 * Extract the provider from a model string (e.g., "anthropic:claude-sonnet-4-5" -> "anthropic")
 * @param modelString - Full model string in format "provider:model-name"
 * @returns The provider part (before the colon), or empty string if no colon is found
 */
export function getModelProvider(modelString: string): string {
  const normalized = normalizeGatewayModel(modelString);
  const colonIndex = normalized.indexOf(":");
  if (colonIndex === -1) {
    return "";
  }
  return normalized.substring(0, colonIndex);
}

/**
 * Check if a model supports the optional 1M context mode used by Mux's context toggle.
 *
 * Supported model families:
 * - Anthropic Claude Sonnet 4/4.5/4.6 and Opus 4.6
 * - OpenAI GPT-5.4 and GPT-5.4 Pro
 *
 * @param modelString - Full model string in format "provider:model-name"
 * @returns True if the model supports 1M context window mode
 */
export function supports1MContext(modelString: string): boolean {
  const normalized = normalizeGatewayModel(modelString);
  const [provider, modelName] = normalized.split(":", 2);
  const lowerModelName = modelName?.toLowerCase() ?? "";

  if (provider === "anthropic") {
    // Sonnet 4, Sonnet 4.5, Sonnet 4.6, and Opus 4.6 support 1M context (beta)
    return (
      (lowerModelName.includes("claude-sonnet-4") && !lowerModelName.includes("claude-sonnet-3")) ||
      lowerModelName.includes("claude-opus-4-6")
    );
  }

  if (provider === "openai") {
    // GPT-5.4 family supports extended context mode. Allow dated suffixes
    // (e.g., gpt-5.4-2026-03-05, gpt-5.4-pro-2026-03-05).
    return /^gpt-5\.4(?:-pro)?(?:$|-[0-9])/.test(lowerModelName);
  }

  return false;
}
