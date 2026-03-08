import type { ProviderModelEntry, ProvidersConfigMap } from "@/common/orpc/types";
import { normalizeToCanonical } from "@/common/utils/ai/models";

interface ParsedProviderModelId {
  provider: string;
  modelId: string;
}

export function getProviderModelEntryId(entry: ProviderModelEntry): string {
  return typeof entry === "string" ? entry : entry.id;
}

export function getProviderModelEntryContextWindowTokens(entry: ProviderModelEntry): number | null {
  if (typeof entry === "string") {
    return null;
  }
  return entry.contextWindowTokens ?? null;
}

export function getProviderModelEntryMappedTo(entry: ProviderModelEntry): string | null {
  if (typeof entry === "string") {
    return null;
  }
  return entry.mappedToModel ?? null;
}

function parseProviderModelId(fullModelId: string): ParsedProviderModelId | null {
  const separatorIndex = fullModelId.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= fullModelId.length - 1) {
    return null;
  }

  return {
    provider: fullModelId.slice(0, separatorIndex),
    modelId: fullModelId.slice(separatorIndex + 1),
  };
}

/**
 * Parse an openai-compatible model ID.
 * Format: "openai-compatible/{instanceId}:{modelId}"
 *
 * Returns { provider, modelId, instanceId } or null if not an openai-compatible model.
 */
function parseOpenAICompatibleModelId(
  fullModelId: string
): { provider: string; modelId: string; instanceId: string } | null {
  // Format: openai-compatible/{instanceId}:{modelId}
  if (fullModelId.startsWith("openai-compatible/")) {
    const colonIndex = fullModelId.indexOf(":");
    if (colonIndex === -1 || colonIndex <= "openai-compatible/".length) {
      return null;
    }
    return {
      provider: fullModelId.slice(0, colonIndex),
      modelId: fullModelId.slice(colonIndex + 1),
      instanceId: fullModelId.slice("openai-compatible/".length, colonIndex),
    };
  }

  return null;
}

export function findProviderModelEntry(
  providersConfig: ProvidersConfigMap | null,
  provider: string,
  modelId: string
): ProviderModelEntry | null {
  const entries = providersConfig?.[provider]?.models;
  if (!entries || entries.length === 0) {
    return null;
  }

  return null;
}

/**
 * Scoped-first provider model entry lookup.
 *
 * Checks the raw (possibly gateway-scoped) provider block first so
 * gateway-local overrides like contextWindowTokens and mappedToModel
 * take effect. Falls back to canonical lookup only when the scoped
 * lookup misses.
 */
function findProviderModelEntryScoped(
  fullModelId: string,
  providersConfig: ProvidersConfigMap | null
): ProviderModelEntry | null {
  const rawParsed = parseProviderModelId(fullModelId);
  if (rawParsed) {
    const scopedEntry = findProviderModelEntry(
      providersConfig,
      rawParsed.provider,
      rawParsed.modelId
    );
    if (scopedEntry) {
      return scopedEntry;
    }
  }

  const canonical = normalizeToCanonical(fullModelId);
  if (canonical === fullModelId) {
    return null;
  }

  const canonicalParsed = parseProviderModelId(canonical);
  if (!canonicalParsed) {
    return null;
  }

  return findProviderModelEntry(providersConfig, canonicalParsed.provider, canonicalParsed.modelId);
}

export function getModelContextWindowOverride(
  fullModelId: string,
  providersConfig: ProvidersConfigMap | null
): number | null {
  const entry = findProviderModelEntryScoped(fullModelId, providersConfig);
  return entry ? getProviderModelEntryContextWindowTokens(entry) : null;
}

export function resolveModelForMetadata(
  fullModelId: string,
  providersConfig: ProvidersConfigMap | null
): string {
  const entry = findProviderModelEntryScoped(fullModelId, providersConfig);
  return (entry ? getProviderModelEntryMappedTo(entry) : null) ?? fullModelId;
}

function parseModelId(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") {
    return null;
  }

  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseContextWindowTokens(rawValue: unknown): number | null {
  if (typeof rawValue !== "number" || !Number.isInteger(rawValue) || rawValue <= 0) {
    return null;
  }

  return rawValue;
}

export function normalizeProviderModelEntry(rawEntry: unknown): ProviderModelEntry | null {
  if (typeof rawEntry === "string") {
    const modelId = parseModelId(rawEntry);
    return modelId ?? null;
  }

  if (typeof rawEntry !== "object" || rawEntry === null) {
    return null;
  }

  const entry = rawEntry as {
    id?: unknown;
    contextWindowTokens?: unknown;
    mappedToModel?: unknown;
  };
  const modelId = parseModelId(entry.id);
  if (!modelId) {
    return null;
  }

  const contextWindowTokens = parseContextWindowTokens(entry.contextWindowTokens);
  const mappedToModel = parseModelId(entry.mappedToModel);
  if (contextWindowTokens === null && mappedToModel === null) {
    return modelId;
  }

  return {
    id: modelId,
    ...(contextWindowTokens !== null ? { contextWindowTokens } : {}),
    ...(mappedToModel !== null ? { mappedToModel } : {}),
  };
}

export function normalizeProviderModelEntries(rawEntries: unknown): ProviderModelEntry[] {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const normalized: ProviderModelEntry[] = [];
  const seen = new Set<string>();

  for (const rawEntry of rawEntries) {
    const normalizedEntry = normalizeProviderModelEntry(rawEntry);
    if (!normalizedEntry) {
      continue;
    }

    const modelId = getProviderModelEntryId(normalizedEntry);
    if (seen.has(modelId)) {
      continue;
    }

    seen.add(modelId);
    normalized.push(normalizedEntry);
  }

  return normalized;
}
