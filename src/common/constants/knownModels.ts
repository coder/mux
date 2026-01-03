/**
 * Centralized model metadata. Update model versions here and everywhere else will follow.
 */

import { formatModelDisplayName } from "../utils/ai/modelDisplay";

type ModelProvider = "anthropic" | "openai" | "google" | "xai";

interface KnownModelDefinition {
  /** Provider identifier used by SDK factories */
  provider: ModelProvider;
  /** Provider-specific model name (no provider prefix) */
  providerModelId: string;
  /** Aliases that should resolve to this model */
  aliases?: string[];
  /** Preload tokenizer encodings at startup */
  warm?: boolean;
  /** Optional tokenizer override for ai-tokenizer */
  tokenizerOverride?: string;
  /** Context window size in tokens */
  contextWindow?: number;
  /** Brief description of the model's strengths */
  description?: string;
}

interface KnownModel extends KnownModelDefinition {
  /** Full model id string in the format provider:model */
  id: `${ModelProvider}:${string}`;
}

// Model definitions. Note we avoid listing legacy models here. These represent the focal models
// of the community.
const MODEL_DEFINITIONS = {
  OPUS: {
    provider: "anthropic",
    providerModelId: "claude-opus-4-5",
    aliases: ["opus"],
    warm: true,
    contextWindow: 200_000,
    description: "Most capable, best for complex reasoning and nuanced tasks",
  },
  SONNET: {
    provider: "anthropic",
    providerModelId: "claude-sonnet-4-5",
    aliases: ["sonnet"],
    warm: true,
    tokenizerOverride: "anthropic/claude-sonnet-4.5",
    contextWindow: 200_000,
    description: "Balanced performance and speed, supports extended 1M context",
  },
  HAIKU: {
    provider: "anthropic",
    providerModelId: "claude-haiku-4-5",
    aliases: ["haiku"],
    tokenizerOverride: "anthropic/claude-3.5-haiku",
    contextWindow: 200_000,
    description: "Fast and cost-effective for simpler tasks",
  },
  GPT: {
    provider: "openai",
    providerModelId: "gpt-5.2",
    aliases: ["gpt"],
    warm: true,
    tokenizerOverride: "openai/gpt-5",
    contextWindow: 272_000,
    description: "OpenAI flagship, strong general-purpose performance",
  },
  GPT_PRO: {
    provider: "openai",
    providerModelId: "gpt-5.2-pro",
    aliases: ["gpt-pro"],
    contextWindow: 272_000,
    description: "Enhanced reasoning with extended thinking capabilities",
  },
  GPT_CODEX: {
    provider: "openai",
    providerModelId: "gpt-5.1-codex",
    aliases: ["codex"],
    warm: true,
    tokenizerOverride: "openai/gpt-5",
    contextWindow: 272_000,
    description: "Optimized for code generation and understanding",
  },
  GPT_MINI: {
    provider: "openai",
    providerModelId: "gpt-5.1-codex-mini",
    aliases: ["codex-mini"],
    contextWindow: 272_000,
    description: "Compact Codex variant, faster with lower cost",
  },
  GPT_CODEX_MAX: {
    provider: "openai",
    providerModelId: "gpt-5.1-codex-max",
    aliases: ["codex-max"],
    warm: true,
    tokenizerOverride: "openai/gpt-5",
    contextWindow: 272_000,
    description: "Maximum capability Codex for complex code tasks",
  },
  GEMINI_3_PRO: {
    provider: "google",
    providerModelId: "gemini-3-pro-preview",
    aliases: ["gemini-3", "gemini-3-pro"],
    tokenizerOverride: "google/gemini-2.5-pro",
    contextWindow: 1_000_000,
    description: "Google flagship with 1M token context window",
  },
  GEMINI_3_FLASH: {
    provider: "google",
    providerModelId: "gemini-3-flash-preview",
    aliases: ["gemini-3-flash"],
    tokenizerOverride: "google/gemini-2.5-pro",
    contextWindow: 1_000_000,
    description: "Fast Gemini variant with 1M context",
  },
  GROK_4_1: {
    provider: "xai",
    providerModelId: "grok-4-1-fast",
    aliases: ["grok", "grok-4", "grok-4.1", "grok-4-1"],
    contextWindow: 131_072,
    description: "xAI flagship model, strong reasoning capabilities",
  },
  GROK_CODE: {
    provider: "xai",
    providerModelId: "grok-code-fast-1",
    aliases: ["grok-code"],
    contextWindow: 131_072,
    description: "xAI code-specialized model",
  },
} as const satisfies Record<string, KnownModelDefinition>;

export type KnownModelKey = keyof typeof MODEL_DEFINITIONS;
const MODEL_DEFINITION_ENTRIES = Object.entries(MODEL_DEFINITIONS) as Array<
  [KnownModelKey, KnownModelDefinition]
>;

export const KNOWN_MODELS = Object.fromEntries(
  MODEL_DEFINITION_ENTRIES.map(([key, definition]) => toKnownModelEntry(key, definition))
);
function toKnownModelEntry<K extends KnownModelKey>(
  key: K,
  definition: KnownModelDefinition
): [K, KnownModel] {
  return [
    key,
    {
      ...definition,
      id: `${definition.provider}:${definition.providerModelId}`,
    },
  ];
}

export function getKnownModel(key: KnownModelKey): KnownModel {
  return KNOWN_MODELS[key];
}

// ------------------------------------------------------------------------------------
// Derived collections
// ------------------------------------------------------------------------------------

/** The default model key - change this single line to update the global default */
export const DEFAULT_MODEL_KEY: KnownModelKey = "OPUS";

export const DEFAULT_MODEL = KNOWN_MODELS[DEFAULT_MODEL_KEY].id;

export const DEFAULT_WARM_MODELS = Object.values(KNOWN_MODELS)
  .filter((model) => model.warm)
  .map((model) => model.id);

export const MODEL_ABBREVIATIONS: Record<string, string> = Object.fromEntries(
  Object.values(KNOWN_MODELS)
    .flatMap((model) => (model.aliases ?? []).map((alias) => [alias, model.id] as const))
    .sort(([a], [b]) => a.localeCompare(b))
);

export const TOKENIZER_MODEL_OVERRIDES: Record<string, string> = Object.fromEntries(
  Object.values(KNOWN_MODELS)
    .filter((model) => Boolean(model.tokenizerOverride))
    .map((model) => [model.id, model.tokenizerOverride!])
);

export const MODEL_NAMES: Record<ModelProvider, Record<string, string>> = Object.entries(
  KNOWN_MODELS
).reduce<Record<ModelProvider, Record<string, string>>>(
  (acc, [key, model]) => {
    if (!acc[model.provider]) {
      const emptyRecord: Record<string, string> = {};
      acc[model.provider] = emptyRecord;
    }
    acc[model.provider][key] = model.providerModelId;
    return acc;
  },
  {} as Record<ModelProvider, Record<string, string>>
);

/** Picker-friendly list: { label, value } for each known model */
export const KNOWN_MODEL_OPTIONS = Object.values(KNOWN_MODELS).map((model) => ({
  label: formatModelDisplayName(model.providerModelId),
  value: model.id,
}));

/** Tooltip-friendly abbreviation examples: show representative shortcuts */
export const MODEL_ABBREVIATION_EXAMPLES = (["opus", "sonnet"] as const).map((abbrev) => ({
  abbrev,
  displayName: formatModelDisplayName(MODEL_ABBREVIATIONS[abbrev].split(":")[1]),
}));
