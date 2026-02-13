import { EventEmitter } from "events";
import * as crypto from "crypto";
import { HOST_KEY_APPROVAL_TIMEOUT_MS } from "@/common/constants/ssh";
import type { HostKeyVerificationRequest } from "@/common/orpc/schemas/ssh";

interface PendingEntry {
  host: string;
  timer: ReturnType<typeof setTimeout>;
  waiters: Array<(accept: boolean) => void>;
}

export class HostKeyVerificationService extends EventEmitter {
  private pending = new Map<string, PendingEntry>();
  /** Dedup: host -> inflight requestId. Coalesces concurrent probes for same host. */
  private inflightByHost = new Map<string, string>();
  private readonly timeoutMs: number;

  constructor(timeoutMs = HOST_KEY_APPROVAL_TIMEOUT_MS) {
    super();
    this.timeoutMs = timeoutMs;
  }

  private finalizeRequest(requestId: string, accept: boolean): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    this.inflightByHost.delete(entry.host);

    for (const resolve of entry.waiters) {
      resolve(accept);
    }
  }

  /**
   * Called from SSH pool when a host-key prompt is detected.
   * Blocks until the user responds or timeout fires.
   */
  async requestVerification(
    params: Omit<HostKeyVerificationRequest, "requestId">
  ): Promise<boolean> {
    // Dedup: if a prompt for this host is already pending, append another waiter
    const existingId = this.inflightByHost.get(params.host);
    if (existingId) {
      const entry = this.pending.get(existingId);
      if (entry) {
        return new Promise<boolean>((resolve) => {
          entry.waiters.push(resolve);
        });
      }
    }

    const requestId = crypto.randomUUID();
    this.inflightByHost.set(params.host, requestId);

    return new Promise<boolean>((resolve) => {
      const entry: PendingEntry = {
        host: params.host,
        timer: setTimeout(() => {
          this.finalizeRequest(requestId, false);
        }, this.timeoutMs),
        waiters: [resolve],
      };

      this.pending.set(requestId, entry);
      this.emit("request", { requestId, ...params } satisfies HostKeyVerificationRequest);
    });
  }

  respond(requestId: string, accept: boolean): void {
    this.finalizeRequest(requestId, accept);
  }
}
