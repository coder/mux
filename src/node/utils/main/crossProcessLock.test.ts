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
  test("takes ownership of a stale lock in place and confirms", async () => {
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(lockPath, JSON.stringify({ pid: 1, token: "s", acquiredAt: 0 }));
    const token = await reclaimStaleLock(lockPath, 60_000);
    expect(token).toBeDefined();
    const holder = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as { token: string };
    expect(holder.token).toBe(token!);
    // Mutex and temp files are cleaned up.
    expect(await fsPromises.readdir(path.dirname(lockPath))).toEqual([path.basename(lockPath)]);
  });

  test("never touches a lock that became live/fresh after the caller's observation", async () => {
    // The Codex-flagged three-process race: a caller observed a stale
    // holder, but a competitor completed its own reclaim-and-acquire before
    // this reclaim ran. The fresh re-read inside the mutex must abandon
    // WITHOUT modifying the new owner's confirmed lock (the old design's
    // quarantine/restore could clobber it).
    const lockPath = await tempLockPath();
    const newOwner = { pid: process.pid, token: "new-owner", acquiredAt: Date.now() };
    await fsPromises.writeFile(lockPath, JSON.stringify(newOwner));
    const token = await reclaimStaleLock(lockPath, 60_000);
    expect(token).toBeUndefined();
    const surviving = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as {
      token: string;
    };
    expect(surviving.token).toBe("new-owner");
    expect(await fsPromises.readdir(path.dirname(lockPath))).toEqual([path.basename(lockPath)]);
  });

  test("reclaims a corrupt-but-present lock in place", async () => {
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(lockPath, "not json");
    const token = await reclaimStaleLock(lockPath, 60_000);
    expect(token).toBeDefined();
    const holder = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as { token: string };
    expect(holder.token).toBe(token!);
  });

  test("abandons when the lock file is missing (the wx create path handles absence)", async () => {
    const lockPath = await tempLockPath();
    expect(await reclaimStaleLock(lockPath, 60_000)).toBeUndefined();
    expect(await pathExists(lockPath)).toBe(false);
    expect(await fsPromises.readdir(path.dirname(lockPath))).toEqual([]);
  });

  test("backs off while a competing reclaimer holds a fresh reclaim mutex", async () => {
    const lockPath = await tempLockPath();
    const stale = JSON.stringify({ pid: 1, token: "s", acquiredAt: 0 });
    await fsPromises.writeFile(lockPath, stale);
    const mutexDir = `${lockPath}.reclaim`;
    await fsPromises.mkdir(mutexDir);
    await fsPromises.writeFile(path.join(mutexDir, "owner"), "competitor");
    const token = await reclaimStaleLock(lockPath, 60_000);
    expect(token).toBeUndefined();
    // The stale lock and the competitor's mutex are untouched.
    expect(await fsPromises.readFile(lockPath, "utf-8")).toBe(stale);
    expect(await fsPromises.readFile(path.join(mutexDir, "owner"), "utf-8")).toBe("competitor");
  });

  test("breaks a reclaim mutex abandoned by a crashed reclaimer", async () => {
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(lockPath, JSON.stringify({ pid: 1, token: "s", acquiredAt: 0 }));
    const mutexDir = `${lockPath}.reclaim`;
    await fsPromises.mkdir(mutexDir);
    // Age the mutex beyond RECLAIM_MUTEX_STALE_MS.
    const old = new Date(Date.now() - 60_000);
    await fsPromises.utimes(mutexDir, old, old);
    const token = await reclaimStaleLock(lockPath, 60_000);
    expect(token).toBeDefined();
    const holder = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as { token: string };
    expect(holder.token).toBe(token!);
  });

  test("the lock path is never absent during a successful reclaim", async () => {
    // Watch for absence with a tight poller while a reclaim runs. rename-over
    // is atomic, so no observer may ever see ENOENT — the property that keeps
    // a third process's wx-create from slipping in mid-reclaim.
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(lockPath, JSON.stringify({ pid: 1, token: "s", acquiredAt: 0 }));
    let sawAbsent = false;
    let stop = false;
    const watcher = (async () => {
      while (!stop) {
        if (!(await pathExists(lockPath))) {
          sawAbsent = true;
        }
      }
    })();
    const token = await reclaimStaleLock(lockPath, 60_000);
    stop = true;
    await watcher;
    expect(token).toBeDefined();
    expect(sawAbsent).toBe(false);
  });
});
