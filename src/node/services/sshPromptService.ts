import { EventEmitter } from "events";
import * as crypto from "crypto";
import { HOST_KEY_APPROVAL_TIMEOUT_MS } from "@/common/constants/ssh";
import type {
  SshCredentialPromptRequest,
  SshHostKeyPromptRequest,
  SshPromptRequest,
} from "@/common/orpc/schemas/ssh";

type SshPromptRequestParams =
  | (Omit<SshHostKeyPromptRequest, "requestId"> & { dedupeKey?: string })
  | (Omit<SshCredentialPromptRequest, "requestId"> & { dedupeKey?: string });

export type SshPromptResolutionReason = "responded" | "timeout" | "no_responder";

export interface SshPromptResolution {
  response: string;
  reason: SshPromptResolutionReason;
}

interface PendingEntry {
  request: SshPromptRequest;
  dedupeKey: string | null;
  timer: ReturnType<typeof setTimeout>;
  waiters: Array<(resolution: SshPromptResolution) => void>;
}

export class SshPromptService extends EventEmitter {
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
    onRequest: (req: SshPromptRequest) => void,
    onRemoved?: (requestId: string) => void
  ): {
    snapshot: SshPromptRequest[];
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

  // NOTE: `resolution.response` may contain credentials. Never log response values.
  private finalizeRequest(requestId: string, resolution: SshPromptResolution): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    if (entry.dedupeKey) {
      this.inflightByDedupeKey.delete(entry.dedupeKey);
    }
    this.emit("removed", requestId);

    for (const resolve of entry.waiters) {
      resolve(resolution);
    }
  }

  private joinPendingByDedupeKey(dedupeKey: string): Promise<SshPromptResolution> | undefined {
    const existingId = this.inflightByDedupeKey.get(dedupeKey);
    if (!existingId) {
      return undefined;
    }

    const entry = this.pending.get(existingId);
    if (!entry) {
      this.inflightByDedupeKey.delete(dedupeKey);
      return undefined;
    }

    return new Promise<SshPromptResolution>((resolve) => {
      entry.waiters.push(resolve);
    });
  }

  /**
   * Called from SSH pool when a prompt is detected.
   * Blocks until the user responds or timeout fires.
   * Responder admission only applies to new prompts; deduped callers can still
   * join an existing pending prompt even during transient responder gaps.
   */
  async requestPromptDetailed(params: SshPromptRequestParams): Promise<SshPromptResolution> {
    const dedupeKey = params.kind === "host-key" ? (params.dedupeKey ?? params.host) : null;

    if (dedupeKey) {
      const joinedPending = this.joinPendingByDedupeKey(dedupeKey);
      if (joinedPending) {
        return joinedPending;
      }
    }

    if (!this.hasInteractiveResponder()) {
      return { response: "", reason: "no_responder" };
    }

    const requestId = crypto.randomUUID();
    if (dedupeKey) {
      this.inflightByDedupeKey.set(dedupeKey, requestId);
    }

    const requestWithoutId =
      params.kind === "host-key"
        ? {
            kind: "host-key" as const,
            host: params.host,
            keyType: params.keyType,
            fingerprint: params.fingerprint,
            prompt: params.prompt,
          }
        : {
            kind: "credential" as const,
            prompt: params.prompt,
            secret: params.secret,
          };

    return new Promise<SshPromptResolution>((resolve) => {
      const request: SshPromptRequest = { requestId, ...requestWithoutId };
      const entry: PendingEntry = {
        request,
        dedupeKey,
        timer: setTimeout(() => {
          this.finalizeRequest(requestId, { response: "", reason: "timeout" });
        }, this.timeoutMs),
        waiters: [resolve],
      };

      this.pending.set(requestId, entry);
      this.emit("request", request);
    });
  }

  async requestPrompt(params: SshPromptRequestParams): Promise<string> {
    const resolution = await this.requestPromptDetailed(params);
    return resolution.response;
  }

  respond(requestId: string, response: string): void {
    this.finalizeRequest(requestId, { response, reason: "responded" });
  }
}
