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
 * ownership re-read so two processes that both observed the path absent
 * cannot both proceed — the clobbered one fails the token check and retries.
 *
 * STALE RECLAMATION never deletes or renames the lock file (a delayed
 * unlink/rename could destroy a NEW owner's confirmed lock and let two
 * transactions run concurrently). Instead, reclaimers serialize through a
 * short-lived mkdir mutex and take ownership by atomically REPLACING the lock
 * file's content in place (temp + rename). The lock path is therefore never
 * absent during reclamation, so no third process can slip in a `wx` create
 * mid-reclaim; the only competitors are other reclaimers, which the mutex
 * serializes. See reclaimStaleLock.
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
 * A reclaimer stuck longer than this inside the (tiny) reclaim critical
 * section is presumed crashed and its mutex is broken. The section performs
 * only a handful of filesystem operations, so seconds of margin is plenty.
 */
const RECLAIM_MUTEX_STALE_MS = 15_000;

/**
 * Take ownership of a stale/corrupt lock WITHOUT ever making the lock path
 * absent. Returns the token that now owns the lock, or undefined when the
 * reclaim was abandoned (competitor holds the reclaim mutex, the holder
 * turned out live/fresh on re-read, or the file disappeared).
 *
 * Protocol:
 * 1. mkdir `<lockPath>.reclaim` — the reclaim mutex. Atomic: exactly one
 *    reclaimer enters; others back off and retry the main loop. A mutex dir
 *    older than RECLAIM_MUTEX_STALE_MS (crashed reclaimer) is broken.
 * 2. Inside the mutex, RE-READ the lock and re-evaluate staleness on the
 *    fresh content. A lock that changed since the caller's observation
 *    belongs to a new owner and is left untouched.
 * 3. Take ownership by atomically REPLACING the file content (temp +
 *    rename-over). The path never goes absent, so a competing `wx` create
 *    cannot slip in between "remove stale" and "create ours" — the failure
 *    mode the previous delete-based design had. Immediately before the
 *    rename, re-verify we still own the reclaim mutex (a competitor may have
 *    broken it during an arbitrary pause); abandon if not.
 * 4. Confirm ownership with a post-rename re-read (same as the `wx` path).
 *
 * Exported for tests.
 */
export async function reclaimStaleLock(
  lockPath: string,
  staleMs: number
): Promise<string | undefined> {
  const mutexDir = `${lockPath}.reclaim`;
  const mutexToken = randomBytes(16).toString("hex");
  const mutexTokenFile = path.join(mutexDir, "owner");

  const enterMutex = async (): Promise<boolean> => {
    try {
      await fsPromises.mkdir(mutexDir);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      // Break a mutex abandoned by a crashed reclaimer, then retry ONCE.
      // (A live reclaimer finishes in milliseconds; see the stale ceiling.)
      try {
        const stat = await fsPromises.stat(mutexDir);
        if (Date.now() - stat.mtimeMs <= RECLAIM_MUTEX_STALE_MS) {
          return false;
        }
        await fsPromises.rm(mutexDir, { recursive: true, force: true });
      } catch {
        return false;
      }
      try {
        await fsPromises.mkdir(mutexDir);
      } catch {
        return false;
      }
    }
    await fsPromises.writeFile(mutexTokenFile, mutexToken);
    return true;
  };

  const ownsMutex = async (): Promise<boolean> => {
    try {
      return (await fsPromises.readFile(mutexTokenFile, "utf-8")) === mutexToken;
    } catch {
      return false;
    }
  };

  if (!(await enterMutex())) {
    return undefined;
  }
  try {
    // Fresh re-read INSIDE the mutex: the caller's observation may predate a
    // completed reclaim-and-acquire by a competitor. A live fresh holder is
    // never touched. (Corrupt-but-present files re-read as undefined and stay
    // reclaimable; a MISSING file aborts — the `wx` path handles absence.)
    try {
      await fsPromises.stat(lockPath);
    } catch {
      return undefined;
    }
    const current = await readLockHolder(lockPath);
    if (current !== undefined && holderAlive(current, staleMs)) {
      return undefined;
    }

    const token = randomBytes(16).toString("hex");
    const tempPath = `${lockPath}.claim-${token}`;
    await fsPromises.writeFile(
      tempPath,
      JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() })
    );
    // Last-instant mutex re-check: if we paused long enough for a competitor
    // to break our mutex and reclaim, our rename would clobber ITS confirmed
    // lock. (A pause landing exactly between this check and the rename is the
    // residual window; it requires a >15s stall across two adjacent syscalls.)
    if (!(await ownsMutex())) {
      await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
      return undefined;
    }
    try {
      await fsPromises.rename(tempPath, lockPath);
    } catch (error) {
      await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    const confirmed = await readLockHolder(lockPath);
    return confirmed?.token === token ? token : undefined;
  } finally {
    // Release only OUR mutex: a competitor that broke ours owns the dir now.
    if (await ownsMutex()) {
      await fsPromises.rm(mutexDir, { recursive: true, force: true }).catch(() => undefined);
    }
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
  const deadline = Date.now() + acquireTimeoutMs;
  const releaseFor = (token: string) => async () => {
    const current = await readLockHolder(lockPath);
    if (current?.token === token) {
      await fsPromises.rm(lockPath, { force: true }).catch(() => undefined);
    }
  };
  for (;;) {
    const token = randomBytes(16).toString("hex");
    try {
      await fsPromises.writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }),
        { flag: "wx" }
      );
      const confirmed = await readLockHolder(lockPath);
      if (confirmed?.token === token) {
        return releaseFor(token);
      }
      // Our create was clobbered by a concurrent reclaimer: retry.
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      const holder = await readLockHolder(lockPath);
      if (holder === undefined || !holderAlive(holder, staleMs)) {
        // Corrupt/unreadable or dead-owner lock: take ownership in place via
        // the serialized reclaim protocol (never deletes the path).
        const reclaimedToken = await reclaimStaleLock(lockPath, staleMs);
        if (reclaimedToken !== undefined) {
          return releaseFor(reclaimedToken);
        }
      }
    }
    if (Date.now() > deadline) {
      throw new Error(timeoutMessage);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 + Math.floor(Math.random() * 250)));
  }
}
