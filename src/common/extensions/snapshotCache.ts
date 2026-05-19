import { z } from "zod";

export const SNAPSHOT_CACHE_VERSION = 1 as const;
export const SNAPSHOT_CACHE_MANIFEST_VERSION = 1 as const;

export const StateFileFingerprintSchema = z
  .object({
    path: z.string().min(1),
    exists: z.boolean(),
    mtimeMs: z.number(),
    sha256: z.string(),
  })
  .strict();

export type StateFileFingerprint = z.infer<typeof StateFileFingerprintSchema>;

export const SnapshotCacheSchema = z
  .object({
    cacheVersion: z.literal(SNAPSHOT_CACHE_VERSION),
    appVersion: z.string().min(1),
    manifestVersion: z.literal(SNAPSHOT_CACHE_MANIFEST_VERSION),
    stateFileFingerprints: z.array(StateFileFingerprintSchema),
    snapshot: z.unknown(),
  })
  .strict();

export type SnapshotCache = z.infer<typeof SnapshotCacheSchema>;

export interface ValidateSnapshotCacheInput {
  raw: unknown;
  appVersion: string;
  liveFingerprints: readonly StateFileFingerprint[];
}

export type SnapshotCacheInvalidationReason = "shape" | "appVersion" | "stateFiles";

export type ValidateSnapshotCacheResult =
  | { ok: true; snapshot: unknown }
  | { ok: false; reason: SnapshotCacheInvalidationReason };

export function validateSnapshotCache(
  input: ValidateSnapshotCacheInput
): ValidateSnapshotCacheResult {
  const parsed = SnapshotCacheSchema.safeParse(input.raw);
  if (!parsed.success) {
    return { ok: false, reason: "shape" };
  }
  const { data } = parsed;
  if (data.appVersion !== input.appVersion) {
    return { ok: false, reason: "appVersion" };
  }
  if (!fingerprintsMatch(data.stateFileFingerprints, input.liveFingerprints)) {
    return { ok: false, reason: "stateFiles" };
  }
  return { ok: true, snapshot: data.snapshot };
}

function fingerprintsMatch(
  cached: readonly StateFileFingerprint[],
  live: readonly StateFileFingerprint[]
): boolean {
  if (cached.length !== live.length) return false;
  const cachedByPath = new Map(cached.map((f) => [f.path, f]));
  for (const f of live) {
    const c = cachedByPath.get(f.path);
    if (!c) return false;
    if (c.exists !== f.exists || c.mtimeMs !== f.mtimeMs || c.sha256 !== f.sha256) {
      return false;
    }
  }
  return true;
}
