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

const PROVIDER_KEY_ALIASES: Record<string, string> = {
  // GitHub Copilot keys in models.json use underscores for LiteLLM provider names.
  "github-copilot": "github_copilot",
};

function parseNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/**
 * Validates raw model data has required fields
 */
function isValidModelData(data: RawModelData): boolean {
  const maxInputTokens = parseNum(data.max_input_tokens);
  return maxInputTokens != null && maxInputTokens > 0;
}

/**
 * Extracts ModelStats from validated raw data
 */
function extractModelStats(data: RawModelData): ModelStats {
  return {
    max_input_tokens: parseNum(data.max_input_tokens) ?? 0,
    max_output_tokens: parseNum(data.max_output_tokens) ?? undefined,
    // Subscription providers like GitHub Copilot omit per-token costs.
    input_cost_per_token:
      typeof data.input_cost_per_token === "number" ? data.input_cost_per_token : 0,
    output_cost_per_token:
      typeof data.output_cost_per_token === "number" ? data.output_cost_per_token : 0,
    cache_creation_input_token_cost:
      typeof data.cache_creation_input_token_cost === "number"
        ? data.cache_creation_input_token_cost
        : undefined,
    cache_read_input_token_cost:
      typeof data.cache_read_input_token_cost === "number"
        ? data.cache_read_input_token_cost
        : undefined,
  };
}

/**
 * Generates lookup keys for a model string with multiple naming patterns
 * Handles LiteLLM conventions like "ollama/model-cloud" and "provider/model"
 */
function generateLookupKeys(modelString: string): string[] {
  const colonIndex = modelString.indexOf(":");
  const provider = colonIndex !== -1 ? modelString.slice(0, colonIndex) : "";
  const modelName = colonIndex !== -1 ? modelString.slice(colonIndex + 1) : modelString;
  const litellmProvider = PROVIDER_KEY_ALIASES[provider] ?? provider;

  const keys: string[] = [];

  // Prefer provider-scoped matches first so provider-specific limits win over generic entries.
  if (provider) {
    keys.push(`${litellmProvider}/${modelName}`, `${litellmProvider}/${modelName}-cloud`);

    // Fallback: strip size suffix for base model lookup
    // "ollama:gpt-oss:20b" → "ollama/gpt-oss"
    if (modelName.includes(":")) {
      const baseModel = modelName.split(":")[0];
      keys.push(`${litellmProvider}/${baseModel}`);
    }
  }

  keys.push(modelName);

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
