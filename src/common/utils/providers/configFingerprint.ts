import type { ProvidersConfigMap } from "@/common/orpc/types";

/**
 * Deterministic FNV-1a hash of a normalized ProvidersConfigMap.
 * Used to detect config changes for cache invalidation.
 */
export function computeProvidersConfigFingerprint(config: ProvidersConfigMap | null): number {
  const normalized = stableNormalize(config ?? {});
  const serialized = JSON.stringify(normalized);

  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < serialized.length; i += 1) {
    hash ^= serialized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0; // FNV prime
  }

  return hash >>> 0;
}

/** Sort object keys recursively for deterministic serialization. */
function stableNormalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce(
        (acc, key) => {
          acc[key] = stableNormalize((value as Record<string, unknown>)[key]);
          return acc;
        },
        {} as Record<string, unknown>
      );
  }
  return value;
}
