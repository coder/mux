import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type {
  BrowserAction,
  BrowserSession,
  BrowserSessionEvent,
} from "@/common/types/browserSession";
import { SUBSCRIPTION_HEARTBEAT_INTERVAL_MS } from "@/common/utils/withQueueHeartbeat";

const INITIAL_RESUBSCRIBE_BACKOFF_MS = 1_000;
const STALE_SUBSCRIPTION_MS = 3 * SUBSCRIPTION_HEARTBEAT_INTERVAL_MS;

const timerControls = vi as typeof vi & {
  advanceTimersByTime(ms: number): void;
  runOnlyPendingTimers(): void;
  clearAllTimers(): void;
  getTimerCount(): number;
};

type BrowserSessionSubscribe = (
  input: { workspaceId: string },
  options: { signal: AbortSignal }
) => Promise<AsyncIterableIterator<BrowserSessionEvent>>;

type MockSubscription = ReturnType<typeof createMockSubscription>;

let currentApi: {
  browserSession: {
    subscribe: BrowserSessionSubscribe;
  };
} | null = null;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: currentApi,
  }),
}));

import { useBrowserSessionSubscription } from "./useBrowserSessionSubscription";

function createMockSubscription() {
  let pendingResolve: ((value: IteratorResult<BrowserSessionEvent>) => void) | null = null;
  const queuedResults: IteratorResult<BrowserSessionEvent>[] = [];
  let closed = false;

  const getDoneResult = (): IteratorReturnResult<undefined> => ({
    done: true,
    value: undefined,
  });

  const resolveNext = (result: IteratorResult<BrowserSessionEvent>) => {
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(result);
      return;
    }

    queuedResults.push(result);
  };

  const returnMock = mock<(value?: unknown) => Promise<IteratorResult<BrowserSessionEvent>>>(
    async (_value?: unknown) => {
      closed = true;
      resolveNext(getDoneResult());
      return getDoneResult();
    }
  );

  const iterator: AsyncIterableIterator<BrowserSessionEvent> = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    next() {
      if (queuedResults.length > 0) {
        return Promise.resolve(queuedResults.shift()!);
      }

      if (closed) {
        return Promise.resolve(getDoneResult());
      }

      return new Promise<IteratorResult<BrowserSessionEvent>>((resolve) => {
        pendingResolve = resolve;
      });
    },
    return(value?: unknown) {
      return returnMock(value);
    },
  };

  return {
    iterator,
    returnMock,
    push(event: BrowserSessionEvent) {
      resolveNext({ done: false, value: event });
    },
    end() {
      closed = true;
      resolveNext({ done: true, value: undefined });
    },
  };
}

function createSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    status: "live",
    currentUrl: "https://example.com",
    title: "Example page",
    lastScreenshotBase64: null,
    lastError: null,
    streamState: "live",
    lastFrameMetadata: {
      deviceWidth: 1280,
      deviceHeight: 720,
      pageScaleFactor: 1,
      offsetTop: 0,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
    },
    streamErrorMessage: null,
    startedAt: "2026-03-17T00:00:00.000Z",
    updatedAt: "2026-03-17T00:00:00.000Z",
    ...overrides,
  };
}

function createAction(overrides: Partial<BrowserAction> = {}): BrowserAction {
  return {
    id: "action-1",
    type: "navigate",
    description: "Navigate",
    timestamp: "2026-03-17T00:00:00.000Z",
    ...overrides,
  };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advanceTime(ms: number) {
  await act(async () => {
    timerControls.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function pushEvent(subscription: MockSubscription, event: BrowserSessionEvent) {
  await act(async () => {
    subscription.push(event);
    await Promise.resolve();
  });
}

async function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });

  await act(async () => {
    document.dispatchEvent(new window.Event("visibilitychange"));
    await Promise.resolve();
  });
}

describe("useBrowserSessionSubscription", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let subscribeMock: ReturnType<typeof mock<BrowserSessionSubscribe>>;
  let subscriptions: MockSubscription[];

  beforeEach(() => {
    vi.useFakeTimers();

    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;

    subscriptions = [];
    subscribeMock = mock<BrowserSessionSubscribe>((_input, _options) => {
      const subscription = createMockSubscription();
      subscriptions.push(subscription);
      return Promise.resolve(subscription.iterator);
    });
    currentApi = {
      browserSession: {
        subscribe: subscribeMock,
      },
    };

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    cleanup();
    currentApi = null;
    timerControls.runOnlyPendingTimers();
    timerControls.clearAllTimers();
    vi.useRealTimers();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("subscribes on mount", async () => {
    renderHook(() => useBrowserSessionSubscription("workspace-1"));
    await flushEffects();

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock.mock.calls[0]?.[0]).toEqual({ workspaceId: "workspace-1" });
    expect(subscribeMock.mock.calls[0]?.[1]).toMatchObject({
      signal: expect.any(AbortSignal),
    });
  });

  test("processes snapshot events", async () => {
    const session = createSession();
    const firstAction = createAction({ id: "action-1", description: "First action" });
    const secondAction = createAction({ id: "action-2", description: "Second action" });

    const { result } = renderHook(() => useBrowserSessionSubscription("workspace-1"));
    await flushEffects();

    await pushEvent(subscriptions[0], {
      type: "snapshot",
      session,
      recentActions: [firstAction, secondAction],
    });

    expect(result.current.session).toBe(session);
    expect(result.current.recentActions).toEqual([secondAction, firstAction]);
    expect(result.current.error).toBeNull();
  });

  test("processes heartbeat events without mutating state", async () => {
    const session = createSession();
    const action = createAction();

    const { result } = renderHook(() => useBrowserSessionSubscription("workspace-1"));
    await flushEffects();

    await pushEvent(subscriptions[0], {
      type: "snapshot",
      session,
      recentActions: [action],
    });

    const sessionBeforeHeartbeat = result.current.session;
    const recentActionsBeforeHeartbeat = result.current.recentActions;
    const errorBeforeHeartbeat = result.current.error;

    await pushEvent(subscriptions[0], { type: "heartbeat" });

    expect(result.current.session).toBe(sessionBeforeHeartbeat);
    expect(result.current.recentActions).toBe(recentActionsBeforeHeartbeat);
    expect(result.current.error).toBe(errorBeforeHeartbeat);
  });

  test("resubscribes after missed heartbeats", async () => {
    const session = createSession();

    renderHook(() => useBrowserSessionSubscription("workspace-1"));
    await flushEffects();

    await pushEvent(subscriptions[0], {
      type: "snapshot",
      session,
      recentActions: [],
    });

    await advanceTime(STALE_SUBSCRIPTION_MS);

    expect(subscribeMock).toHaveBeenCalledTimes(1);

    await advanceTime(INITIAL_RESUBSCRIBE_BACKOFF_MS);

    expect(subscriptions[0]?.returnMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledTimes(2);
  });

  test("preserves the last good snapshot during resubscribe", async () => {
    const session = createSession();
    const action = createAction();

    const { result } = renderHook(() => useBrowserSessionSubscription("workspace-1"));
    await flushEffects();

    await pushEvent(subscriptions[0], {
      type: "snapshot",
      session,
      recentActions: [action],
    });

    await advanceTime(STALE_SUBSCRIPTION_MS);
    await advanceTime(INITIAL_RESUBSCRIBE_BACKOFF_MS);

    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(result.current.session).toBe(session);
    expect(result.current.recentActions).toEqual([action]);
    expect(result.current.error).toBeNull();
  });

  test("pauses subscription when the page becomes hidden", async () => {
    renderHook(() => useBrowserSessionSubscription("workspace-1"));
    await flushEffects();

    await setDocumentHidden(true);

    expect(subscriptions[0]?.returnMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  test("resumes subscription when the page becomes visible again", async () => {
    renderHook(() => useBrowserSessionSubscription("workspace-1"));
    await flushEffects();

    await setDocumentHidden(true);
    await setDocumentHidden(false);
    await flushEffects();

    expect(subscriptions[0]?.returnMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledTimes(2);
  });

  test("cleans up on unmount", async () => {
    const initialTimerCount = timerControls.getTimerCount();

    const hook = renderHook(() => useBrowserSessionSubscription("workspace-1"));
    await flushEffects();

    expect(timerControls.getTimerCount()).toBeGreaterThan(initialTimerCount);

    hook.unmount();
    await flushEffects();

    expect(subscriptions[0]?.returnMock).toHaveBeenCalledTimes(1);
    expect(timerControls.getTimerCount()).toBe(initialTimerCount);

    await advanceTime(STALE_SUBSCRIPTION_MS + INITIAL_RESUBSCRIBE_BACKOFF_MS);

    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });
});
