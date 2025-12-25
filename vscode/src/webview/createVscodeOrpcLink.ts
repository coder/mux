import type { ClientContext, ClientLink, ClientOptions } from "@orpc/client";
import assert from "mux/common/utils/assert";

import type { OrpcResponse, OrpcStreamData, OrpcStreamEnd, OrpcStreamError } from "./protocol";
import type { VscodeBridge } from "./vscodeBridge";

function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `req-${Math.random().toString(16).slice(2)}-${Date.now()}`;
}

class VscodeOrpcAsyncIterator<T> implements AsyncIterator<T>, AsyncIterable<T> {
  private readonly pending: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];

  private readonly buffered: T[] = [];
  private done = false;
  private error: Error | null = null;

  constructor(
    private readonly bridge: VscodeBridge,
    private readonly streamId: string,
    abortSignal: AbortSignal | undefined,
    private readonly onFinish?: () => void
  ) {
    if (abortSignal) {
      if (abortSignal.aborted) {
        this.cancel("AbortSignal already aborted");
      } else {
        abortSignal.addEventListener("abort", () => {
          this.cancel("AbortSignal aborted");
        });
      }
    }
  }

  push(value: T): void {
    if (this.done) {
      return;
    }

    const waiter = this.pending.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }

    this.buffered.push(value);
  }

  end(): void {
    if (this.done) {
      return;
    }

    this.done = true;
    this.onFinish?.();

    while (this.pending.length > 0) {
      const waiter = this.pending.shift();
      waiter?.resolve({ value: undefined as unknown as T, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.done) {
      return;
    }

    this.done = true;
    this.onFinish?.();
    this.error = error instanceof Error ? error : new Error(String(error));

    while (this.pending.length > 0) {
      const waiter = this.pending.shift();
      waiter?.reject(this.error);
    }
  }

  cancel(reason: string): void {
    if (this.done) {
      return;
    }

    this.bridge.postMessage({ type: "orpcStreamCancel", streamId: this.streamId });
    this.fail(new Error(`Stream cancelled: ${reason}`));
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.error) {
      throw this.error;
    }

    if (this.buffered.length > 0) {
      const value = this.buffered.shift() as T;
      return { value, done: false };
    }

    if (this.done) {
      return { value: undefined as unknown as T, done: true };
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  async return(): Promise<IteratorResult<T>> {
    this.cancel("Iterator return() called");
    return { value: undefined as unknown as T, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

export function createVscodeOrpcLink(bridge: VscodeBridge): ClientLink<ClientContext> {
  const pendingCalls = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      abortSignal?: AbortSignal | undefined;
    }
  >();

  const activeStreams = new Map<string, VscodeOrpcAsyncIterator<unknown>>();

  bridge.onMessage((raw) => {
    if (!raw || typeof raw !== "object" || !("type" in raw)) {
      return;
    }

    const type = (raw as { type?: unknown }).type;
    if (type === "orpcResponse") {
      const msg = raw as OrpcResponse;
      const pending = pendingCalls.get(msg.requestId);
      if (!pending) {
        return;
      }

      pendingCalls.delete(msg.requestId);

      if (!msg.ok) {
        pending.reject(new Error(msg.error));
        return;
      }

      if (msg.kind === "value") {
        pending.resolve(msg.value);
        return;
      }

      const iterator = new VscodeOrpcAsyncIterator<unknown>(
        bridge,
        msg.streamId,
        pending.abortSignal,
        () => activeStreams.delete(msg.streamId)
      );
      activeStreams.set(msg.streamId, iterator);
      pending.resolve(iterator);
      return;
    }

    if (type === "orpcStreamData") {
      const msg = raw as OrpcStreamData;
      const stream = activeStreams.get(msg.streamId);
      stream?.push(msg.value);
      return;
    }

    if (type === "orpcStreamEnd") {
      const msg = raw as OrpcStreamEnd;
      const stream = activeStreams.get(msg.streamId);
      stream?.end();
      return;
    }

    if (type === "orpcStreamError") {
      const msg = raw as OrpcStreamError;
      const stream = activeStreams.get(msg.streamId);
      stream?.fail(new Error(msg.error));
    }
  });

  const call = async (path: readonly string[], input: unknown, options: ClientOptions<ClientContext>) => {
    assert(Array.isArray(path), "ORPC call requires path array");

    const requestId = createRequestId();

    if (options.signal?.aborted) {
      throw new Error("ORPC call aborted before dispatch");
    }

    const callPromise = new Promise<unknown>((resolve, reject) => {
      pendingCalls.set(requestId, {
        resolve,
        reject: (error) => reject(error),
        abortSignal: options.signal,
      });
    });

    const onAbort = () => {
      const pending = pendingCalls.get(requestId);
      pendingCalls.delete(requestId);

      if (pending) {
        pending.reject(new Error("ORPC call aborted"));
      }

      bridge.postMessage({ type: "orpcCancel", requestId });
    };

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      bridge.postMessage({
        type: "orpcCall",
        requestId,
        path: [...path],
        input,
        lastEventId: options.lastEventId,
      });

      return await callPromise;
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    }
  };

  return { call };
}
