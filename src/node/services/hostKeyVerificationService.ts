import { EventEmitter } from "events";
import * as crypto from "crypto";
import type { HostKeyVerificationRequest } from "@/common/orpc/schemas/ssh";

const PROMPT_TIMEOUT_MS = 60_000;

interface PendingEntry {
  resolve: (accept: boolean) => void;
}

export class HostKeyVerificationService extends EventEmitter {
  private pending = new Map<string, PendingEntry>();
  /** Dedup: host -> inflight requestId. Coalesces concurrent probes for same host. */
  private inflightByHost = new Map<string, string>();

  /**
   * Called from SSH pool when a host-key prompt is detected.
   * Blocks until the user responds or timeout fires.
   */
  async requestVerification(
    params: Omit<HostKeyVerificationRequest, "requestId">
  ): Promise<boolean> {
    // Dedup: if a prompt for this host is already pending, wait for it
    const existing = this.inflightByHost.get(params.host);
    if (existing) {
      const entry = this.pending.get(existing);
      if (entry) {
        return new Promise<boolean>((resolve) => {
          const orig = entry.resolve;
          entry.resolve = (accept) => {
            orig(accept);
            resolve(accept);
          };
        });
      }
    }

    const requestId = crypto.randomUUID();
    this.inflightByHost.set(params.host, requestId);

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.inflightByHost.delete(params.host);
        resolve(false);
      }, PROMPT_TIMEOUT_MS);

      this.pending.set(requestId, {
        resolve: (accept) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          this.inflightByHost.delete(params.host);
          resolve(accept);
        },
      });

      this.emit("request", { requestId, ...params } satisfies HostKeyVerificationRequest);
    });
  }

  respond(requestId: string, accept: boolean): void {
    this.pending.get(requestId)?.resolve(accept);
  }
}
