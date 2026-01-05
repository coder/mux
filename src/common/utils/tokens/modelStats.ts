import modelsData from "./models.json";
import { modelsExtra } from "./models-extra";
import { normalizeGatewayModel } from "../ai/models";

export interface ModelStats {
  max_input_tokens: number;
  max_output_tokens?: number;
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
}

interface RawModelData {
  max_input_tokens?: number | string | null;
  max_output_tokens?: number | string | null;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  [key: string]: unknown;
}

/**
 * Validates raw model data has required fields
 */
function isValidModelData(data: RawModelData): boolean {
  return (
    typeof data.max_input_tokens === "number" &&
    typeof data.input_cost_per_token === "number" &&
    typeof data.output_cost_per_token === "number"
  );
}

/**
 * Extracts ModelStats from validated raw data
 */
function extractModelStats(data: RawModelData): ModelStats {
  // Type assertions are safe here because isValidModelData() already validated these fields
  /* eslint-disable @typescript-eslint/non-nullable-type-assertion-style */
  return {
    max_input_tokens: data.max_input_tokens as number,
    max_output_tokens:
      typeof data.max_output_tokens === "number" ? data.max_output_tokens : undefined,
    input_cost_per_token: data.input_cost_per_token as number,
    output_cost_per_token: data.output_cost_per_token as number,
    cache_creation_input_token_cost:
      typeof data.cache_creation_input_token_cost === "number"
        ? data.cache_creation_input_token_cost
        : undefined,
    cache_read_input_token_cost:
      typeof data.cache_read_input_token_cost === "number"
        ? data.cache_read_input_token_cost
        : undefined,
  };
  /* eslint-enable @typescript-eslint/non-nullable-type-assertion-style */
}

/**
 * Generates lookup keys for a model string with multiple naming patterns
 * Handles LiteLLM conventions like "ollama/model-cloud" and "provider/model"
 */
function generateLookupKeys(modelString: string): string[] {
  const colonIndex = modelString.indexOf(":");
  const provider = colonIndex !== -1 ? modelString.slice(0, colonIndex) : "";
  const modelName = colonIndex !== -1 ? modelString.slice(colonIndex + 1) : modelString;

  const keys: string[] = [
    modelName, // Direct model name (e.g., "claude-opus-4-1")
  ];

  // Add provider-prefixed variants for Ollama and other providers
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

/**
 * Gets model statistics for a given Vercel AI SDK model string
 * @param modelString - Format: "provider:model-name" (e.g., "anthropic:claude-opus-4-1", "ollama:gpt-oss:20b")
 * @returns ModelStats or null if model not found
 */
export function getModelStats(modelString: string): ModelStats | null {
  const normalized = normalizeGatewayModel(modelString);
  const lookupKeys = generateLookupKeys(normalized);

  // Check models-extra.ts first (overrides for models with incorrect upstream data)
  for (const key of lookupKeys) {
    const data = (modelsExtra as Record<string, RawModelData>)[key];
    if (data && isValidModelData(data)) {
      return extractModelStats(data);
    }
  }

  // Fall back to main models.json
  for (const key of lookupKeys) {
    const data = (modelsData as Record<string, RawModelData>)[key];
    if (data && isValidModelData(data)) {
      return extractModelStats(data);
    }
  }

  return null;
}
