import { describe, expect, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { acquireCrossProcessLock, reclaimStaleLock } from "./crossProcessLock";

async function tempLockPath(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cross-process-lock-"));
  return path.join(dir, "test.lock");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsPromises.stat(target);
    return true;
  } catch {
    return false;
  }
}

const baseOptions = {
  acquireTimeoutMs: 400,
  staleMs: 60_000,
  timeoutMessage: "lock busy",
};

describe("acquireCrossProcessLock", () => {
  test("acquires, blocks a competing acquirer on a live holder, and releases", async () => {
    const lockPath = await tempLockPath();
    const release = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    try {
      await acquireCrossProcessLock({ lockPath, ...baseOptions });
      expect.unreachable("second acquire must time out on a live holder");
    } catch (error) {
      expect((error as Error).message).toBe("lock busy");
    }
    await release();
    expect(await pathExists(lockPath)).toBe(false);
    const release2 = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    await release2();
  });

  test("reclaims a holder past the stale ceiling even when its pid is alive", async () => {
    const lockPath = await tempLockPath();
    // acquiredAt 0 puts the holder beyond any stale ceiling (pid-reuse guard).
    await fsPromises.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, token: "stale", acquiredAt: 0 })
    );
    const release = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    await release();
    expect(await pathExists(lockPath)).toBe(false);
  });

  test("reclaims a corrupt lock file", async () => {
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(lockPath, "not json");
    const release = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    await release();
  });
});

describe("reclaimStaleLock", () => {
  const staleHolder = { pid: 1, token: "stale-token", acquiredAt: 0 };

  test("deletes the lock when it still holds the observed content", async () => {
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(lockPath, JSON.stringify(staleHolder));
    await reclaimStaleLock(lockPath, staleHolder);
    expect(await pathExists(lockPath)).toBe(false);
    // No quarantine leftovers.
    expect(await fsPromises.readdir(path.dirname(lockPath))).toEqual([]);
  });

  test("restores a lock that was replaced after the observation (new owner survives)", async () => {
    // The Codex-flagged race: we read a stale holder, then a concurrent
    // reclaimer completed its own reclaim AND acquired before our removal
    // ran. A plain rm would delete the new owner's live lock; the atomic
    // rename + verify must put it back instead.
    const lockPath = await tempLockPath();
    const newOwner = { pid: process.pid, token: "new-owner", acquiredAt: Date.now() };
    await fsPromises.writeFile(lockPath, JSON.stringify(newOwner));
    await reclaimStaleLock(lockPath, staleHolder);
    const surviving = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as {
      token: string;
    };
    expect(surviving.token).toBe("new-owner");
    expect(await fsPromises.readdir(path.dirname(lockPath))).toEqual([path.basename(lockPath)]);
  });

  test("restores a valid lock when the observation was a corrupt/partial read", async () => {
    // A `wx` creator's content can land after a competitor read the file as
    // empty/corrupt; the completed lock must survive the reclaim attempt.
    const lockPath = await tempLockPath();
    const newOwner = { pid: process.pid, token: "completed-write", acquiredAt: Date.now() };
    await fsPromises.writeFile(lockPath, JSON.stringify(newOwner));
    await reclaimStaleLock(lockPath, undefined);
    const surviving = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as {
      token: string;
    };
    expect(surviving.token).toBe("completed-write");
  });

  test("deletes a corrupt lock observed as corrupt", async () => {
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(lockPath, "not json");
    await reclaimStaleLock(lockPath, undefined);
    expect(await pathExists(lockPath)).toBe(false);
  });

  test("no-ops when a concurrent reclaimer already moved the lock", async () => {
    const lockPath = await tempLockPath();
    await reclaimStaleLock(lockPath, staleHolder);
    expect(await pathExists(lockPath)).toBe(false);
    expect(await fsPromises.readdir(path.dirname(lockPath))).toEqual([]);
  });
});
