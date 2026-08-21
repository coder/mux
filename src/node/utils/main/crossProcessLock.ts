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

export interface LockHolder {
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
 * Reclaim a lock we observed as stale/corrupt WITHOUT the read-then-unlink
 * race: between our read and a plain `rm`, a concurrent reclaimer can finish
 * its own reclaim AND acquire, so the delayed `rm` would delete the NEW
 * owner's live lock and let two transactions run concurrently. Instead,
 * atomically rename the file aside (exactly one reclaimer wins; the loser
 * gets ENOENT and simply retries the create loop) and verify we moved the
 * exact content we judged reclaimable:
 * - match → it really was the stale lock; delete the quarantined file.
 * - mismatch → we stole a lock that was replaced after our read (a new
 *   owner, or a creator whose `wx` write completed after we read a partial
 *   file); rename it back. A third party's `wx`-create inside that gap is
 *   clobbered by the restore, but its post-create ownership re-read detects
 *   the foreign token and retries.
 * Exported for tests.
 */
export async function reclaimStaleLock(
  lockPath: string,
  observed: LockHolder | undefined
): Promise<void> {
  const quarantinePath = `${lockPath}.reclaim-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await fsPromises.rename(lockPath, quarantinePath);
  } catch {
    // ENOENT: a concurrent reclaimer moved it first. Nothing to do.
    return;
  }
  const moved = await readLockHolder(quarantinePath);
  const movedWhatWeObserved =
    moved === undefined
      ? observed === undefined
      : observed !== undefined &&
        moved.pid === observed.pid &&
        moved.token === observed.token &&
        moved.acquiredAt === observed.acquiredAt;
  if (movedWhatWeObserved) {
    await fsPromises.rm(quarantinePath, { force: true }).catch(() => undefined);
    return;
  }
  // Restore failures propagate: leaving the new owner's lock quarantined
  // would release mutual exclusion early, which is exactly the corruption
  // this helper exists to prevent.
  await fsPromises.rename(quarantinePath, lockPath);
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
        // Corrupt/unreadable or dead-owner lock: reclaim atomically (see
        // reclaimStaleLock for why a plain rm is unsafe here) and retry.
        await reclaimStaleLock(lockPath, holder);
        continue;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(timeoutMessage);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 + Math.floor(Math.random() * 250)));
  }
}
