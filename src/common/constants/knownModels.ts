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
  /** Use as global default model */
  isDefault?: boolean;
  /** Optional tokenizer override for ai-tokenizer */
  tokenizerOverride?: string;
}

interface KnownModel extends KnownModelDefinition {
  /** Full model id string in the format provider:model */
  id: `${ModelProvider}:${string}`;
}

// Model definitions. Note we avoid listing legacy models here. These represent the focal models
// of the community.
const MODEL_DEFINITIONS = {
  SONNET: {
    provider: "anthropic",
    providerModelId: "claude-sonnet-4-5",
    aliases: ["sonnet"],
    warm: true,
    isDefault: true,
    tokenizerOverride: "anthropic/claude-sonnet-4.5",
  },
  HAIKU: {
    provider: "anthropic",
    providerModelId: "claude-haiku-4-5",
    aliases: ["haiku"],
    tokenizerOverride: "anthropic/claude-3.5-haiku",
  },
  OPUS: {
    provider: "anthropic",
    providerModelId: "claude-opus-4-5",
    aliases: ["opus"],
  },
  GPT: {
    provider: "openai",
    providerModelId: "gpt-5.1",
    aliases: ["gpt-5.1"],
    warm: true,
    tokenizerOverride: "openai/gpt-5",
  },
  GPT_PRO: {
    provider: "openai",
    providerModelId: "gpt-5-pro",
    aliases: ["gpt-5-pro"],
  },
  GPT_CODEX: {
    provider: "openai",
    providerModelId: "gpt-5.1-codex",
    aliases: ["codex"],
    warm: true,
    tokenizerOverride: "openai/gpt-5",
  },
  GPT_MINI: {
    provider: "openai",
    providerModelId: "gpt-5.1-codex-mini",
    aliases: ["codex-mini"],
  },
  GEMINI_3_PRO: {
    provider: "google",
    providerModelId: "gemini-3-pro-preview",
    aliases: ["gemini-3", "gemini-3-pro"],
    tokenizerOverride: "google/gemini-2.5-pro",
  },
  GROK_4_1: {
    provider: "xai",
    providerModelId: "grok-4-1-fast",
    aliases: ["grok", "grok-4", "grok-4.1", "grok-4-1"],
  },
  GROK_CODE: {
    provider: "xai",
    providerModelId: "grok-code-fast-1",
    aliases: ["grok-code"],
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

const DEFAULT_MODEL_ENTRY =
  Object.values(KNOWN_MODELS).find((model) => model.isDefault) ?? KNOWN_MODELS.SONNET;

export const DEFAULT_MODEL = DEFAULT_MODEL_ENTRY.id;

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
