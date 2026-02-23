import type { ProviderModelEntry, ProvidersConfigMap } from "@/common/orpc/types";
import { normalizeGatewayModel } from "@/common/utils/ai/models";

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

export function parseProviderModelId(fullModelId: string): ParsedProviderModelId | null {
  const separatorIndex = fullModelId.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= fullModelId.length - 1) {
    return null;
  }

  return {
    provider: fullModelId.slice(0, separatorIndex),
    modelId: fullModelId.slice(separatorIndex + 1),
  };
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

  for (const entry of entries) {
    if (getProviderModelEntryId(entry) === modelId) {
      return entry;
    }
  }

  return null;
}

export function getModelContextWindowOverride(
  fullModelId: string,
  providersConfig: ProvidersConfigMap | null
): number | null {
  const normalizedModelId = normalizeGatewayModel(fullModelId);
  const parsed = parseProviderModelId(normalizedModelId);
  if (!parsed) {
    return null;
  }

  const modelEntry = findProviderModelEntry(providersConfig, parsed.provider, parsed.modelId);
  if (!modelEntry) {
    return null;
  }

  return getProviderModelEntryContextWindowTokens(modelEntry);
}

export function resolveModelForMetadata(
  fullModelId: string,
  providersConfig: ProvidersConfigMap | null
): string {
  const normalized = normalizeGatewayModel(fullModelId);
  const parsed = parseProviderModelId(normalized);
  if (!parsed) {
    return fullModelId;
  }

  const entry = findProviderModelEntry(providersConfig, parsed.provider, parsed.modelId);
  if (!entry) {
    return fullModelId;
  }

  return getProviderModelEntryMappedTo(entry) ?? fullModelId;
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
