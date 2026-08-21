import { randomBytes } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { hasErrorCode } from "@/node/services/tools/skillFileUtils";

/**
 * Cross-process advisory file lock.
 *
 * In-process Promise queues serialize only one service instance; two
 * processes sharing the same Xum home (ALLOW_MULTIPLE_INSTANCES, a desktop
 * app alongside `xum server`) each have their own queue, so their
 * read-modify-write transactions on shared files can interleave and the last
 * writer silently drops the other's changes. Holders record `{pid, token,
 * acquiredAt}`; acquisition uses exclusive-create (`wx`) plus a post-create
 * ownership re-read so two processes that both reclaimed a dead holder
 * cannot both proceed — the clobbered one fails the token check and retries.
 */
export interface CrossProcessLockOptions {
  /** Absolute path of the lock file. Its parent directory must exist. */
  lockPath: string;
  /** How long an acquire waits on a live holder before failing. */
  acquireTimeoutMs: number;
  /**
   * Pid-reuse guard: holders older than this are reclaimable even when a
   * process with the recorded pid is alive. Choose comfortably above the
   * longest legitimate hold time.
   */
  staleMs: number;
  /** Error message thrown when the acquire timeout elapses. */
  timeoutMessage: string;
}

interface LockHolder {
  pid: number;
  token: string;
  acquiredAt: number;
}

/** Parse the lock file; undefined when missing/unreadable/corrupt. */
async function readLockHolder(lockPath: string): Promise<LockHolder | undefined> {
  try {
    const parsed = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const { pid, token, acquiredAt } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || typeof token !== "string" || typeof acquiredAt !== "number") {
      return undefined;
    }
    return { pid, token, acquiredAt };
  } catch {
    return undefined;
  }
}

/**
 * Liveness check for a competing holder. Reclaims dead pids immediately; the
 * stale ceiling guards pid reuse. A same-pid holder is NOT reclaimable: it is
 * another service instance in this very process (callers serialize their own
 * instance with an in-process queue first), and a lock leaked by a previous
 * same-pid process is covered by the stale ceiling like any other pid-reuse
 * case.
 */
function holderAlive(holder: LockHolder, staleMs: number): boolean {
  if (Date.now() - holder.acquiredAt > staleMs) {
    return false;
  }
  if (holder.pid === process.pid) {
    return true;
  }
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (error) {
    // EPERM = alive but owned by another user; anything else (ESRCH) = dead.
    return hasErrorCode(error, "EPERM");
  }
}

/**
 * Acquire the lock; returns the release function, which deletes the lock file
 * only while it is still OURS (a reclaimer may have replaced it after the
 * stale ceiling).
 */
export async function acquireCrossProcessLock(
  options: CrossProcessLockOptions
): Promise<() => Promise<void>> {
  const { lockPath, acquireTimeoutMs, staleMs, timeoutMessage } = options;
  await fsPromises.mkdir(path.dirname(lockPath), { recursive: true });
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + acquireTimeoutMs;
  for (;;) {
    try {
      await fsPromises.writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }),
        { flag: "wx" }
      );
      const confirmed = await readLockHolder(lockPath);
      if (confirmed?.token === token) {
        return async () => {
          const current = await readLockHolder(lockPath);
          if (current?.token === token) {
            await fsPromises.rm(lockPath, { force: true }).catch(() => undefined);
          }
        };
      }
      // Our create was clobbered by a concurrent reclaimer: retry.
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      const holder = await readLockHolder(lockPath);
      if (holder === undefined || !holderAlive(holder, staleMs)) {
        // Corrupt/unreadable or dead-owner lock: reclaim and retry. The
        // unlink-then-create race between two reclaimers is compensated by
        // the ownership re-read above.
        await fsPromises.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(timeoutMessage);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 + Math.floor(Math.random() * 250)));
  }
}
