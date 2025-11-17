import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";
import { assert } from "./assert";

type KnownModelEntry = (typeof KNOWN_MODELS)[keyof typeof KNOWN_MODELS];

const MODEL_LIST: KnownModelEntry[] = Object.values(KNOWN_MODELS);
const MODEL_MAP: Record<string, KnownModelEntry> = MODEL_LIST.reduce(
  (acc, model) => {
    acc[model.id] = model;
    return acc;
  },
  {} as Record<string, KnownModelEntry>
);

export const MODEL_PROVIDER_LABELS: Record<KnownModelEntry["provider"], string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
};

export const DEFAULT_MODEL_ID = WORKSPACE_DEFAULTS.model;

export function listKnownModels(): KnownModelEntry[] {
  return MODEL_LIST.slice();
}

export function isKnownModelId(value: string | null | undefined): value is string {
  return typeof value === "string" && Boolean(MODEL_MAP[value]);
}

export function assertKnownModelId(value: string): KnownModelEntry {
  const model = MODEL_MAP[value];
  assert(model, `Unknown model: ${value}`);
  return model;
}

export function getModelDisplayName(modelId: string): string {
  const model = MODEL_MAP[modelId];
  if (!model) {
    return modelId;
  }
  return formatModelDisplayName(model.providerModelId);
}

export function getProviderLabel(provider: KnownModelEntry["provider"]): string {
  return MODEL_PROVIDER_LABELS[provider] ?? provider;
}

export function formatModelSummary(modelId: string): string {
  const model = MODEL_MAP[modelId];
  if (!model) {
    return modelId;
  }
  const providerLabel = getProviderLabel(model.provider);
  const modelName = formatModelDisplayName(model.providerModelId);
  return `${providerLabel} · ${modelName}`;
}

export function sanitizeModelSequence(models: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of models) {
    if (!isKnownModelId(candidate) || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    result.push(candidate);
  }

  if (!seen.has(DEFAULT_MODEL_ID) && isKnownModelId(DEFAULT_MODEL_ID)) {
    result.unshift(DEFAULT_MODEL_ID);
  }

  return result;
}
