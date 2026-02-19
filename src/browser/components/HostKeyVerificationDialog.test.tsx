import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type {
  HostKeyVerificationEvent,
  HostKeyVerificationRequest,
} from "@/common/orpc/schemas/ssh";
import type { ReactNode } from "react";

// Self-contained dialog stub — bun's mock.module is process-global and
// ShareTranscriptDialog.test.tsx registers an incomplete stub that omits
// DialogDescription/DialogFooter/Warning*. Our own complete mock prevents
// Radix context errors when tests run in the same bun process.
void mock.module("@/browser/components/ui/dialog", () => ({
  Dialog: (props: { open: boolean; children: ReactNode }) =>
    props.open ? <div>{props.children}</div> : null,
  DialogContent: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogTitle: (props: { children: ReactNode }) => <h2>{props.children}</h2>,
  DialogDescription: (props: { children: ReactNode }) => <p>{props.children}</p>,
  DialogFooter: (props: { children: ReactNode }) => <div>{props.children}</div>,
  WarningBox: (props: { children: ReactNode }) => <div>{props.children}</div>,
  WarningTitle: (props: { children: ReactNode }) => <div>{props.children}</div>,
  WarningText: (props: { children: ReactNode }) => <div>{props.children}</div>,
}));

import { HostKeyVerificationDialog } from "./HostKeyVerificationDialog";

interface ControlledSubscription<T> {
  iterable: AsyncIterable<T>;
  push: (value: T) => void;
  close: () => void;
  returnSpy: ReturnType<typeof mock>;
}

function createMockIterableSubscription<T>(): ControlledSubscription<T> {
  const buffered: T[] = [];
  const pending: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  const doneResult = (): IteratorResult<T> => ({
    value: undefined as unknown as T,
    done: true,
  });

  const flushDone = () => {
    while (pending.length > 0) {
      const resolve = pending.shift();
      resolve?.(doneResult());
    }
  };

  const returnSpy = mock((_value?: unknown) => {
    closed = true;
    flushDone();
    return Promise.resolve(doneResult());
  });

  const iterator: AsyncIterator<T> = {
    next() {
      if (closed) {
        return Promise.resolve(doneResult());
      }

      if (buffered.length > 0) {
        return Promise.resolve({ value: buffered.shift()!, done: false });
      }

      return new Promise((resolve) => {
        pending.push(resolve);
      });
    },
    return: returnSpy,
  };

  return {
    iterable: {
      [Symbol.asyncIterator]: () => iterator,
    },
    returnSpy,
    push(value: T) {
      if (closed) {
        return;
      }

      const resolve = pending.shift();
      if (resolve) {
        resolve({ value, done: false });
        return;
      }

      buffered.push(value);
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      flushDone();
    },
  };
}

interface HostKeyVerificationApi {
  ssh: {
    hostKeyVerification: {
      subscribe: (
        _input?: undefined,
        _options?: { signal?: AbortSignal }
      ) => Promise<AsyncIterable<HostKeyVerificationEvent>>;
      respond: (input: { requestId: string; accept: boolean }) => Promise<void>;
    };
  };
}

let api: HostKeyVerificationApi | null = null;
let respondMock: ReturnType<typeof mock>;
let subscribeMock: ReturnType<typeof mock>;
let mockSubscription: ControlledSubscription<HostKeyVerificationEvent>;

// mock.module is hoisted by bun — the mock is active before static imports resolve.
void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api }),
}));

const MOCK_REQUEST: HostKeyVerificationRequest = {
  requestId: "req-1",
  host: "example.com",
  keyType: "ssh-ed25519",
  fingerprint: "SHA256:abcdef",
  prompt: "Trust host key?",
};

async function flushReactWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function enqueueRequest(request: HostKeyVerificationRequest): Promise<void> {
  await act(async () => {
    mockSubscription.push({ type: "request", ...request });
    await flushReactWork();
  });
}

describe("HostKeyVerificationDialog", () => {
  beforeEach(() => {
    cleanup();

    mockSubscription = createMockIterableSubscription<HostKeyVerificationEvent>();
    respondMock = mock(() => Promise.resolve());
    subscribeMock = mock(() => Promise.resolve(mockSubscription.iterable));

    api = {
      ssh: {
        hostKeyVerification: {
          subscribe: subscribeMock,
          respond: respondMock,
        },
      },
    };
  });

  afterEach(() => {
    mockSubscription.close();
    cleanup();
    api = null;
  });

  it("dequeues request on successful respond", async () => {
    const { getByRole, queryByRole } = render(<HostKeyVerificationDialog />);

    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    await enqueueRequest(MOCK_REQUEST);

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Reject" }));
      await flushReactWork();
    });

    await waitFor(() => {
      expect(respondMock).toHaveBeenCalledWith({ requestId: "req-1", accept: false });
    });
    expect(respondMock).toHaveBeenCalledTimes(1);

    // Successful respond dequeues → dialog closes → no Reject button
    expect(queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("keeps request visible when respond fails", async () => {
    respondMock = mock(() => Promise.reject(new Error("RPC transport error")));
    subscribeMock = mock(() => Promise.resolve(mockSubscription.iterable));
    api = {
      ssh: {
        hostKeyVerification: {
          subscribe: subscribeMock,
          respond: respondMock,
        },
      },
    };

    const { getByRole, queryByRole } = render(<HostKeyVerificationDialog />);

    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    await enqueueRequest(MOCK_REQUEST);

    // Regression guard: failed responses must leave the same prompt active so retry works.
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Reject" }));
      await flushReactWork();
    });
    await waitFor(() => expect(respondMock).toHaveBeenCalledTimes(1));

    // Button still visible — user can retry
    expect(queryByRole("button", { name: "Reject" })).not.toBeNull();

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Reject" }));
      await flushReactWork();
    });
    await waitFor(() => expect(respondMock).toHaveBeenCalledTimes(2));

    expect(respondMock).toHaveBeenNthCalledWith(1, { requestId: "req-1", accept: false });
    expect(respondMock).toHaveBeenNthCalledWith(2, { requestId: "req-1", accept: false });
  });

  it("closes late iterator when cleanup runs before subscribe resolves", async () => {
    let resolveSubscribe: ((iterable: AsyncIterable<HostKeyVerificationEvent>) => void) | null =
      null;
    subscribeMock = mock(
      () =>
        new Promise<AsyncIterable<HostKeyVerificationEvent>>((resolve) => {
          resolveSubscribe = resolve;
        })
    );
    api = {
      ssh: {
        hostKeyVerification: {
          subscribe: subscribeMock,
          respond: respondMock,
        },
      },
    };

    const { unmount } = render(<HostKeyVerificationDialog />);
    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));

    // Cleanup fires while subscribe() is still pending — iteratorRef is undefined.
    unmount();

    // Now resolve the subscribe promise. The abort guard should close the iterator.
    await act(async () => {
      resolveSubscribe?.(mockSubscription.iterable);
      await flushReactWork();
    });

    // The abort guard should have called return() on the late iterator.
    await waitFor(() => expect(mockSubscription.returnSpy).toHaveBeenCalledTimes(1));
  });

  it("does not double-close iterator on normal cleanup", async () => {
    const { unmount } = render(<HostKeyVerificationDialog />);
    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    await enqueueRequest(MOCK_REQUEST);

    unmount();

    // Give async tasks time to settle.
    await act(async () => {
      await flushReactWork();
    });

    // Normal cleanup path: return() called exactly once.
    expect(mockSubscription.returnSpy).toHaveBeenCalledTimes(1);
  });

  it("clears pending queue when api becomes null", async () => {
    const { queryByRole, rerender } = render(<HostKeyVerificationDialog />);

    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    await enqueueRequest(MOCK_REQUEST);

    // Dialog should be visible
    expect(queryByRole("button", { name: "Reject" })).not.toBeNull();

    // Simulate disconnect — api becomes null
    api = null;
    await act(async () => {
      rerender(<HostKeyVerificationDialog />);
      await flushReactWork();
    });

    // Queue cleared → dialog dismissed
    expect(queryByRole("button", { name: "Reject" })).toBeNull();
  });
});
