import { describe, expect, test } from "bun:test";
import {
  SNAPSHOT_CACHE_VERSION,
  validateSnapshotCache,
  type StateFileFingerprint,
} from "./snapshotCache";

const APP_VERSION = "1.2.3";

const EMPTY_FINGERPRINTS: StateFileFingerprint[] = [];

function buildValidCacheBlob(snapshot: unknown = { availableContributions: [] }): unknown {
  return {
    cacheVersion: SNAPSHOT_CACHE_VERSION,
    appVersion: APP_VERSION,
    manifestVersion: 1,
    stateFileFingerprints: EMPTY_FINGERPRINTS,
    snapshot,
  };
}

describe("validateSnapshotCache", () => {
  test("validates a well-formed cache against matching live fingerprints", () => {
    const result = validateSnapshotCache({
      raw: buildValidCacheBlob({ availableContributions: [{ type: "skill", id: "x" }] }),
      appVersion: APP_VERSION,
      liveFingerprints: EMPTY_FINGERPRINTS,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot).toEqual({ availableContributions: [{ type: "skill", id: "x" }] });
    }
  });

  test("invalidates a malformed (non-object) blob with reason 'shape'", () => {
    const result = validateSnapshotCache({
      raw: "not an object",
      appVersion: APP_VERSION,
      liveFingerprints: EMPTY_FINGERPRINTS,
    });
    expect(result).toEqual({ ok: false, reason: "shape" });
  });

  test("invalidates a missing cacheVersion / unknown shape with reason 'shape'", () => {
    const result = validateSnapshotCache({
      raw: { snapshot: {} },
      appVersion: APP_VERSION,
      liveFingerprints: EMPTY_FINGERPRINTS,
    });
    expect(result).toEqual({ ok: false, reason: "shape" });
  });

  test("invalidates an unknown future cacheVersion with reason 'shape'", () => {
    const result = validateSnapshotCache({
      raw: { ...(buildValidCacheBlob() as object), cacheVersion: 999 },
      appVersion: APP_VERSION,
      liveFingerprints: EMPTY_FINGERPRINTS,
    });
    expect(result).toEqual({ ok: false, reason: "shape" });
  });

  test("invalidates when appVersion does not match the running build", () => {
    const result = validateSnapshotCache({
      raw: buildValidCacheBlob(),
      appVersion: "9.9.9",
      liveFingerprints: EMPTY_FINGERPRINTS,
    });
    expect(result).toEqual({ ok: false, reason: "appVersion" });
  });

  test("invalidates when manifestVersion is anything other than 1", () => {
    const blob = { ...(buildValidCacheBlob() as object), manifestVersion: 2 };
    const result = validateSnapshotCache({
      raw: blob,
      appVersion: APP_VERSION,
      liveFingerprints: EMPTY_FINGERPRINTS,
    });
    // Discriminator literal 1 → schema reject → "shape"; either way, invalidation is silent.
    expect(result.ok).toBe(false);
  });

  test("invalidates when a recorded state file's mtime drifted", () => {
    const fingerprint: StateFileFingerprint = {
      path: "/tmp/state.json",
      exists: true,
      mtimeMs: 100,
      sha256: "a".repeat(64),
    };
    const result = validateSnapshotCache({
      raw: buildValidCacheBlob() as Record<string, unknown> & {
        stateFileFingerprints: StateFileFingerprint[];
      },
      appVersion: APP_VERSION,
      liveFingerprints: [fingerprint],
    });
    // Cache was written with no fingerprints, but live now has one → mismatch.
    expect(result).toEqual({ ok: false, reason: "stateFiles" });
  });

  test("invalidates when a recorded state file's sha256 drifted", () => {
    const cached: StateFileFingerprint = {
      path: "/tmp/state.json",
      exists: true,
      mtimeMs: 100,
      sha256: "a".repeat(64),
    };
    const live: StateFileFingerprint = { ...cached, sha256: "b".repeat(64) };
    const blob = {
      ...(buildValidCacheBlob() as object),
      stateFileFingerprints: [cached],
    };
    const result = validateSnapshotCache({
      raw: blob,
      appVersion: APP_VERSION,
      liveFingerprints: [live],
    });
    expect(result).toEqual({ ok: false, reason: "stateFiles" });
  });

  test("invalidates when the cache records a state file that no longer exists live", () => {
    const cached: StateFileFingerprint = {
      path: "/tmp/state.json",
      exists: true,
      mtimeMs: 100,
      sha256: "a".repeat(64),
    };
    const blob = {
      ...(buildValidCacheBlob() as object),
      stateFileFingerprints: [cached],
    };
    const result = validateSnapshotCache({
      raw: blob,
      appVersion: APP_VERSION,
      liveFingerprints: [],
    });
    expect(result).toEqual({ ok: false, reason: "stateFiles" });
  });

  test("invalidates when a state file existence flag drifted (was missing, now present)", () => {
    const cached: StateFileFingerprint = {
      path: "/tmp/state.json",
      exists: false,
      mtimeMs: 0,
      sha256: "",
    };
    const live: StateFileFingerprint = {
      path: "/tmp/state.json",
      exists: true,
      mtimeMs: 200,
      sha256: "c".repeat(64),
    };
    const blob = {
      ...(buildValidCacheBlob() as object),
      stateFileFingerprints: [cached],
    };
    const result = validateSnapshotCache({
      raw: blob,
      appVersion: APP_VERSION,
      liveFingerprints: [live],
    });
    expect(result).toEqual({ ok: false, reason: "stateFiles" });
  });

  test("validates regardless of fingerprint ordering", () => {
    const a: StateFileFingerprint = {
      path: "/tmp/a.json",
      exists: true,
      mtimeMs: 1,
      sha256: "a".repeat(64),
    };
    const b: StateFileFingerprint = {
      path: "/tmp/b.json",
      exists: true,
      mtimeMs: 2,
      sha256: "b".repeat(64),
    };
    const blob = {
      ...(buildValidCacheBlob() as object),
      stateFileFingerprints: [a, b],
    };
    const result = validateSnapshotCache({
      raw: blob,
      appVersion: APP_VERSION,
      liveFingerprints: [b, a],
    });
    expect(result.ok).toBe(true);
  });
});
