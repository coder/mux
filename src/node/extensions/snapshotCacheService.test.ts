import * as fs from "fs";
import { access, readFile, readdir, stat, unlink, writeFile, utimes } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SnapshotCacheService } from "./snapshotCacheService";

const APP_VERSION = "1.2.3";

interface FakeContribution {
  type: string;
  id: string;
  extensionId: string;
}

interface FakeSnapshot {
  availableContributions: FakeContribution[];
}

// Minimal stand-in for the Extension Registry Service (US-013). The Capability
// Path reads only from `liveSnapshot`, never from any cache. The Inspection
// Path is allowed to fall back to the cache if no live snapshot is available
// yet (cold start). This module exists to prove the boundary in tests; the
// real registry replaces it in US-013.
class TestRegistry {
  liveSnapshot: FakeSnapshot | null = null;
  constructor(private readonly cache: SnapshotCacheService) {}

  // Capability Path: NEVER reads the cache. Returns empty when no live
  // snapshot has been published yet.
  getContributions(type: string): FakeContribution[] {
    if (!this.liveSnapshot) return [];
    return this.liveSnapshot.availableContributions.filter((c) => c.type === type);
  }

  // Inspection Path: live first; cache is only a cold-start fallback.
  async getDescriptors(
    type: string,
    stateFilePaths: readonly string[]
  ): Promise<FakeContribution[]> {
    if (this.liveSnapshot) {
      return this.liveSnapshot.availableContributions.filter((c) => c.type === type);
    }
    const cached = await this.cache.read<FakeSnapshot>(stateFilePaths);
    if (!cached) return [];
    return cached.availableContributions.filter((c) => c.type === type);
  }
}

describe("SnapshotCacheService", () => {
  let muxHome: string;
  let cachePath: string;
  let stateFile: string;
  let service: SnapshotCacheService;

  beforeEach(() => {
    muxHome = fs.mkdtempSync(path.join(os.tmpdir(), "mux-snapshot-cache-"));
    cachePath = path.join(muxHome, "extension-snapshot.cache.json");
    stateFile = path.join(muxHome, "config.json");
    service = new SnapshotCacheService({ cacheFilePath: cachePath, appVersion: APP_VERSION });
  });

  afterEach(() => {
    fs.rmSync(muxHome, { recursive: true, force: true });
  });

  test("read() returns null when no cache file exists", async () => {
    const result = await service.read([]);
    expect(result).toBeNull();
  });

  test("write() creates the cache file via atomic write (no .tmp leftovers)", async () => {
    await service.write({ availableContributions: [] }, []);
    const entries = await readdir(muxHome);
    const tmpEntries = entries.filter((e) => e.includes(".tmp") || e.endsWith("~"));
    expect(tmpEntries).toEqual([]);
    expect(entries).toContain("extension-snapshot.cache.json");
  });

  test("write() then read() round-trips the snapshot payload verbatim", async () => {
    const snapshot: FakeSnapshot = {
      availableContributions: [
        { type: "skill", id: "alpha", extensionId: "publisher.alpha" },
        { type: "agent", id: "beta", extensionId: "publisher.alpha" },
      ],
    };
    await service.write(snapshot, []);
    const result = await service.read<FakeSnapshot>([]);
    expect(result).toEqual(snapshot);
  });

  test("write() records mtime+sha256 fingerprints of every contributing state file", async () => {
    await writeFile(stateFile, JSON.stringify({ schemaVersion: 1 }), "utf-8");
    await service.write({ availableContributions: [] }, [stateFile]);

    const blob = JSON.parse(await readFile(cachePath, "utf-8")) as {
      stateFileFingerprints: Array<{
        path: string;
        exists: boolean;
        mtimeMs: number;
        sha256: string;
      }>;
    };
    expect(blob.stateFileFingerprints).toHaveLength(1);
    expect(blob.stateFileFingerprints[0]).toMatchObject({
      path: stateFile,
      exists: true,
    });
    expect(blob.stateFileFingerprints[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(blob.stateFileFingerprints[0].mtimeMs).toBeGreaterThan(0);
  });

  test("read() returns null silently when appVersion mismatches", async () => {
    await service.write({ availableContributions: [] }, []);
    const stale = new SnapshotCacheService({ cacheFilePath: cachePath, appVersion: "9.9.9" });
    const result = await stale.read([]);
    expect(result).toBeNull();
  });

  test("read() returns null silently when cacheVersion is unknown (future format)", async () => {
    await service.write({ availableContributions: [] }, []);
    const blob = JSON.parse(await readFile(cachePath, "utf-8")) as Record<string, unknown>;
    blob.cacheVersion = 999;
    await writeFile(cachePath, JSON.stringify(blob), "utf-8");
    expect(await service.read([])).toBeNull();
  });

  test("read() returns null silently when manifestVersion is not 1", async () => {
    await service.write({ availableContributions: [] }, []);
    const blob = JSON.parse(await readFile(cachePath, "utf-8")) as Record<string, unknown>;
    blob.manifestVersion = 2;
    await writeFile(cachePath, JSON.stringify(blob), "utf-8");
    expect(await service.read([])).toBeNull();
  });

  test("read() returns null silently when a state file's mtime drifted", async () => {
    await writeFile(stateFile, "v1", "utf-8");
    await service.write({ availableContributions: [] }, [stateFile]);
    // Touch the file to drift the mtime; sha256 may also change if content does.
    const future = new Date(Date.now() + 60_000);
    await utimes(stateFile, future, future);
    expect(await service.read([stateFile])).toBeNull();
  });

  test("read() returns null silently when a state file's content (hash) drifted", async () => {
    await writeFile(stateFile, "v1", "utf-8");
    await service.write({ availableContributions: [] }, [stateFile]);
    // Replace content but force the same mtime back so only sha256 differs.
    const before = await stat(stateFile);
    await writeFile(stateFile, "v2-different-content", "utf-8");
    await utimes(stateFile, before.atime, before.mtime);
    expect(await service.read([stateFile])).toBeNull();
  });

  test("read() returns null silently when a state file existed at write time but is gone", async () => {
    await writeFile(stateFile, "v1", "utf-8");
    await service.write({ availableContributions: [] }, [stateFile]);
    await unlink(stateFile);
    expect(await service.read([stateFile])).toBeNull();
  });

  test("read() returns null silently when a state file is added after write", async () => {
    // Cache written with the file missing; later, the file exists.
    await service.write({ availableContributions: [] }, [stateFile]);
    await writeFile(stateFile, "v1", "utf-8");
    expect(await service.read([stateFile])).toBeNull();
  });

  test("read() returns null silently for a corrupted (non-JSON) cache file", async () => {
    await writeFile(cachePath, "{not json", "utf-8");
    expect(await service.read([])).toBeNull();
  });

  test("read() returns null silently when shape is mutated to be unrecognized", async () => {
    await service.write({ availableContributions: [] }, []);
    await writeFile(cachePath, JSON.stringify({ unrelated: "data" }), "utf-8");
    expect(await service.read([])).toBeNull();
  });

  test("cold-start first-paint contract: Inspection Path renders from cache before live snapshot exists", async () => {
    const seedSnapshot: FakeSnapshot = {
      availableContributions: [{ type: "skill", id: "alpha", extensionId: "publisher.alpha" }],
    };
    await service.write(seedSnapshot, []);

    const registry = new TestRegistry(service);
    // Cold start: liveSnapshot is null. Inspection Path must serve cached descriptors.
    expect(await registry.getDescriptors("skill", [])).toEqual(seedSnapshot.availableContributions);

    // Capability Path returns empty until live discovery publishes a snapshot.
    expect(registry.getContributions("skill")).toEqual([]);

    // Once live discovery completes, Inspection Path follows live state.
    registry.liveSnapshot = { availableContributions: [] };
    expect(await registry.getDescriptors("skill", [])).toEqual([]);
  });

  test("security regression: a mutated cache claiming a fake contribution does NOT influence Capability Path", async () => {
    const realSnapshot: FakeSnapshot = {
      availableContributions: [{ type: "skill", id: "real", extensionId: "publisher.alpha" }],
    };
    await service.write(realSnapshot, []);

    // Attacker (or stale-cache) mutation: inject an availability claim for a
    // contribution that was never in the live registry.
    const blob = JSON.parse(await readFile(cachePath, "utf-8")) as {
      snapshot: FakeSnapshot;
    };
    blob.snapshot.availableContributions.push({
      type: "skill",
      id: "evil",
      extensionId: "evil.attacker",
    });
    await writeFile(cachePath, JSON.stringify(blob), "utf-8");

    const registry = new TestRegistry(service);
    registry.liveSnapshot = realSnapshot;

    // Capability Path: ignores the cache entirely → no fake contribution.
    const skills = registry.getContributions("skill");
    expect(skills.find((c) => c.id === "evil")).toBeUndefined();
    expect(skills.map((c) => c.id)).toEqual(["real"]);
  });

  test("write() overwrites a previous cache file in place", async () => {
    await service.write(
      { availableContributions: [{ type: "skill", id: "v1", extensionId: "x.x" }] },
      []
    );
    await service.write(
      { availableContributions: [{ type: "skill", id: "v2", extensionId: "x.x" }] },
      []
    );
    const cached = await service.read<FakeSnapshot>([]);
    expect(cached?.availableContributions[0]?.id).toBe("v2");
  });

  test("write() ensures the cache parent directory exists", async () => {
    const nested = path.join(muxHome, "nested", "subdir", "extension-snapshot.cache.json");
    const nestedService = new SnapshotCacheService({
      cacheFilePath: nested,
      appVersion: APP_VERSION,
    });
    await nestedService.write({ availableContributions: [] }, []);
    await access(nested);
  });

  test("multiple state files: cache stays valid while every fingerprint matches", async () => {
    const stateA = path.join(muxHome, "stateA.json");
    const stateB = path.join(muxHome, "stateB.json");
    await writeFile(stateA, "A", "utf-8");
    await writeFile(stateB, "B", "utf-8");
    await service.write({ availableContributions: [] }, [stateA, stateB]);
    const cached = await service.read<FakeSnapshot>([stateA, stateB]);
    expect(cached).toEqual({ availableContributions: [] });
  });

  test("multiple state files: drift on any single file invalidates the cache", async () => {
    const stateA = path.join(muxHome, "stateA.json");
    const stateB = path.join(muxHome, "stateB.json");
    await writeFile(stateA, "A", "utf-8");
    await writeFile(stateB, "B", "utf-8");
    await service.write({ availableContributions: [] }, [stateA, stateB]);
    // Drift only B.
    const before = await stat(stateB);
    await writeFile(stateB, "B-changed", "utf-8");
    await utimes(stateB, before.atime, before.mtime);
    expect(await service.read([stateA, stateB])).toBeNull();
  });
});
