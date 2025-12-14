import { getErrorMessage } from "@/common/utils/errors";
import type { InitLogger } from "./Runtime";

export interface SSHInitRetryOptions {
  /**
   * Max attempts (including the first).
   *
   * Default is intentionally small: init should be resilient to brief flakiness,
   * but should not hang indefinitely on a genuinely down host.
   */
  maxAttempts?: number;
  /** Max total time spent sleeping between attempts. */
  maxTotalWaitMs?: number;
  abortSignal?: AbortSignal;
  initLogger?: InitLogger;

  /**
   * Test seam.
   *
   * If provided, this is used for sleeping between attempts.
   */
  sleep?: (ms: number, abortSignal?: AbortSignal) => Promise<void>;
}

export function parseBackoffSecondsFromErrorMessage(message: string): number | null {
  const re = /in backoff for (\d+)s/i;
  const match = re.exec(message);
  if (!match) return null;
  const secs = Number(match[1]);
  return Number.isFinite(secs) ? secs : null;
}

export function isRetryableSSHTransportErrorMessage(message: string): boolean {
  // We want to be conservative here: only retry errors that are clearly SSH transport issues.
  // Do NOT retry generic git errors (auth, missing branch, merge conflicts, etc.).
  const m = message.toLowerCase();

  // Errors originating from our SSHConnectionPool / SSHRuntime.
  if (m.includes("ssh connection failed")) return true;
  if (
    m.includes("ssh probe") &&
    (m.includes("timed out") || m.includes("failed") || m.includes("spawn error"))
  ) {
    return true;
  }

  // Errors coming directly from the `ssh` binary (common transient/network issues).
  if (m.includes("could not resolve hostname")) return true;
  if (m.includes("connection timed out")) return true;
  if (m.includes("connection refused")) return true;
  if (m.includes("no route to host")) return true;
  if (m.includes("network is unreachable")) return true;
  if (m.includes("broken pipe")) return true;
  if (m.includes("kex_exchange_identification")) return true;
  if (m.includes("connection reset by peer")) return true;

  // Many SSH failures are prefixed like: "ssh: Could not resolve hostname ...".
  if (
    m.includes("ssh:") &&
    (m.includes("could not") || m.includes("connection") || m.includes("timed out"))
  ) {
    return true;
  }

  return false;
}

export async function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (abortSignal?.aborted) {
    throw new Error("Operation aborted");
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error("Operation aborted"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
    };

    abortSignal?.addEventListener("abort", onAbort);
  });
}

function formatRetryMessage(delayMs: number, attempt: number, maxAttempts: number): string {
  const delaySecs = Math.max(1, Math.ceil(delayMs / 1000));
  return `SSH connection issue; retrying in ${delaySecs}s (attempt ${attempt}/${maxAttempts})...`;
}

export async function retrySSHForInit<T>(
  operation: () => Promise<T>,
  options: SSHInitRetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 8;
  const maxTotalWaitMs = options.maxTotalWaitMs ?? 2 * 60 * 1000;
  const sleep = options.sleep ?? sleepWithAbort;

  let totalWaitMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.abortSignal?.aborted) {
      throw new Error("Operation aborted");
    }

    try {
      return await operation();
    } catch (error) {
      if (options.abortSignal?.aborted) {
        throw new Error("Operation aborted");
      }

      const message = getErrorMessage(error);

      const backoffSecs = parseBackoffSecondsFromErrorMessage(message);
      const isRetryable = backoffSecs !== null || isRetryableSSHTransportErrorMessage(message);

      if (!isRetryable) {
        throw error;
      }

      if (attempt >= maxAttempts) {
        throw error;
      }

      const delayMs =
        backoffSecs !== null ? backoffSecs * 1000 : Math.min(1000 * 2 ** (attempt - 1), 10_000);

      if (totalWaitMs + delayMs > maxTotalWaitMs) {
        throw error;
      }

      totalWaitMs += delayMs;
      options.initLogger?.logStep(formatRetryMessage(delayMs, attempt + 1, maxAttempts));
      await sleep(delayMs, options.abortSignal);
    }
  }

  // Unreachable (loop either returns or throws)
  throw new Error("SSH init retry loop exited unexpectedly");
}
