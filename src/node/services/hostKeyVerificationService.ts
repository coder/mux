import { EventEmitter } from "events";
import * as crypto from "crypto";
import { HOST_KEY_APPROVAL_TIMEOUT_MS } from "@/common/constants/ssh";
import type { HostKeyVerificationRequest } from "@/common/orpc/schemas/ssh";

interface PendingEntry {
  request: HostKeyVerificationRequest;
  dedupeKey: string;
  timer: ReturnType<typeof setTimeout>;
  waiters: Array<(accept: boolean) => void>;
}

export class HostKeyVerificationService extends EventEmitter {
  private pending = new Map<string, PendingEntry>();
  /**
   * Dedup: endpoint identity -> inflight requestId.
   * Callers can provide host+port identity to avoid cross-port prompt coalescing.
   */
  private inflightByDedupeKey = new Map<string, string>();
  private activeResponders = 0;
  private readonly timeoutMs: number;

  constructor(timeoutMs = HOST_KEY_APPROVAL_TIMEOUT_MS) {
    super();
    this.timeoutMs = timeoutMs;
  }

  registerInteractiveResponder(): () => void {
    this.activeResponders += 1;

    let released = false;
    return () => {
      if (released) {
        return;
      }

      released = true;
      this.activeResponders = Math.max(0, this.activeResponders - 1);

      // Keep responder count as an admission gate only. Pending requests are
      // not rejected on disconnect and instead resolve via explicit respond()
      // or timeout, which prevents reconnect churn from killing in-flight
      // prompts.
    };
  }

  hasInteractiveResponder(): boolean {
    return this.activeResponders > 0;
  }

  /**
   * Atomic subscribe+snapshot: register listener FIRST, then return current
   * pending requests. Any request emitted between registration and snapshot
   * appears in both the listener and snapshot — callers must deduplicate
   * (the frontend already does via requestId check in setPendingQueue).
   */
  subscribeRequests(
    onRequest: (req: HostKeyVerificationRequest) => void,
    onRemoved?: (requestId: string) => void
  ): {
    snapshot: HostKeyVerificationRequest[];
    unsubscribe: () => void;
  } {
    this.on("request", onRequest);
    if (onRemoved) this.on("removed", onRemoved);
    return {
      snapshot: Array.from(this.pending.values()).map((entry) => entry.request),
      unsubscribe: () => {
        this.off("request", onRequest);
        if (onRemoved) this.off("removed", onRemoved);
      },
    };
  }

  private finalizeRequest(requestId: string, accept: boolean): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    this.inflightByDedupeKey.delete(entry.dedupeKey);
    this.emit("removed", requestId);

    for (const resolve of entry.waiters) {
      resolve(accept);
    }
  }

  private joinPendingByDedupeKey(dedupeKey: string): Promise<boolean> | undefined {
    const existingId = this.inflightByDedupeKey.get(dedupeKey);
    if (!existingId) {
      return undefined;
    }

    const entry = this.pending.get(existingId);
    if (!entry) {
      this.inflightByDedupeKey.delete(dedupeKey);
      return undefined;
    }

    return new Promise<boolean>((resolve) => {
      entry.waiters.push(resolve);
    });
  }

  /**
   * Called from SSH pool when a host-key prompt is detected.
   * Blocks until the user responds or timeout fires.
   * Responder admission only applies to new prompts; deduped callers can still
   * join an existing pending prompt even during transient responder gaps.
   */
  async requestVerification(
    params: Omit<HostKeyVerificationRequest, "requestId"> & { dedupeKey?: string }
  ): Promise<boolean> {
    const { dedupeKey: dedupeKeyOverride, ...requestParams } = params;
    const dedupeKey = dedupeKeyOverride ?? requestParams.host;

    const joinedPending = this.joinPendingByDedupeKey(dedupeKey);
    if (joinedPending) {
      return joinedPending;
    }

    if (!this.hasInteractiveResponder()) {
      return false;
    }

    const requestId = crypto.randomUUID();
    this.inflightByDedupeKey.set(dedupeKey, requestId);

    return new Promise<boolean>((resolve) => {
      const request: HostKeyVerificationRequest = { requestId, ...requestParams };
      const entry: PendingEntry = {
        request,
        dedupeKey,
        timer: setTimeout(() => {
          this.finalizeRequest(requestId, false);
        }, this.timeoutMs),
        waiters: [resolve],
      };

      this.pending.set(requestId, entry);
      this.emit("request", request);
    });
  }

  respond(requestId: string, accept: boolean): void {
    this.finalizeRequest(requestId, accept);
  }
}
