import * as path from "path";
import { mkdir, readFile, stat } from "fs/promises";
import { createHash } from "crypto";
import writeFileAtomic from "write-file-atomic";
import {
  SNAPSHOT_CACHE_MANIFEST_VERSION,
  SNAPSHOT_CACHE_VERSION,
  validateSnapshotCache,
  type SnapshotCache,
  type StateFileFingerprint,
} from "@/common/extensions/snapshotCache";

export interface SnapshotCacheServiceOptions {
  cacheFilePath: string;
  appVersion: string;
}

// Inspection Path only: the Capability Path (getContributions(type)) MUST
// NOT consume read() output as authority. A stale or attacker-mutated cache
// cannot grant capabilities. See the security regression test in
// snapshotCacheService.test.ts.
export class SnapshotCacheService {
  constructor(private readonly options: SnapshotCacheServiceOptions) {}

  async read<TSnapshot = unknown>(stateFilePaths: readonly string[]): Promise<TSnapshot | null> {
    const raw = await this.readRaw();
    if (raw === undefined) return null;

    const liveFingerprints = await fingerprintFiles(stateFilePaths);
    const result = validateSnapshotCache({
      raw,
      appVersion: this.options.appVersion,
      liveFingerprints,
    });
    if (!result.ok) return null;
    return result.snapshot as TSnapshot;
  }

  async write(snapshot: unknown, stateFilePaths: readonly string[]): Promise<void> {
    const stateFileFingerprints = await fingerprintFiles(stateFilePaths);
    const payload: SnapshotCache = {
      cacheVersion: SNAPSHOT_CACHE_VERSION,
      appVersion: this.options.appVersion,
      manifestVersion: SNAPSHOT_CACHE_MANIFEST_VERSION,
      stateFileFingerprints,
      snapshot,
    };
    await mkdir(path.dirname(this.options.cacheFilePath), { recursive: true });
    await writeFileAtomic(
      this.options.cacheFilePath,
      JSON.stringify(payload, null, 2) + "\n",
      "utf-8"
    );
  }

  private async readRaw(): Promise<unknown> {
    try {
      const content = await readFile(this.options.cacheFilePath, "utf-8");
      return JSON.parse(content) as unknown;
    } catch {
      return undefined;
    }
  }
}

async function fingerprintFiles(paths: readonly string[]): Promise<StateFileFingerprint[]> {
  return Promise.all(paths.map(fingerprintFile));
}

function missingFingerprint(filePath: string): StateFileFingerprint {
  return { path: filePath, exists: false, mtimeMs: 0, sha256: "" };
}

async function fingerprintFile(filePath: string): Promise<StateFileFingerprint> {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return missingFingerprint(filePath);
    const content = await readFile(filePath);
    return {
      path: filePath,
      exists: true,
      mtimeMs: st.mtimeMs,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } catch {
    return missingFingerprint(filePath);
  }
}
