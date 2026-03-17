import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type {
  BrowserAction,
  BrowserSession,
  BrowserSessionEvent,
} from "@/common/types/browserSession";
import { SUBSCRIPTION_HEARTBEAT_INTERVAL_MS } from "@/common/utils/withQueueHeartbeat";
import type { useBrowserSessionSubscription as UseBrowserSessionSubscription } from "./useBrowserSessionSubscription";

const INITIAL_RESUBSCRIBE_BACKOFF_MS = 1_000;
const STALE_SUBSCRIPTION_MS = 3 * SUBSCRIPTION_HEARTBEAT_INTERVAL_MS;

interface TimerRecord {
  callback: () => void;
  runAt: number;
}

interface InstalledTimerGlobals {
  clearTimeout: typeof globalThis.clearTimeout;
  dateNow: typeof Date.now;
  setTimeout: typeof globalThis.setTimeout;
  windowClearTimeout: typeof window.clearTimeout;
  windowSetTimeout: typeof window.setTimeout;
}

type TimeoutCallback = (...args: unknown[]) => void;

type BrowserSessionSubscribe = (
  input: { workspaceId: string },
  options: { signal: AbortSignal }
) => Promise<AsyncIterableIterator<BrowserSessionEvent>>;

const uninitializedSubscribeMock: BrowserSessionSubscribe = () => {
  throw new Error("Expected subscribe mock to be initialized before use");
};

let currentSubscribeMock: BrowserSessionSubscribe = uninitializedSubscribeMock;

const mockedApi = {
  browserSession: {
    subscribe(input: { workspaceId: string }, options: { signal: AbortSignal }) {
      return currentSubscribeMock(input, options);
    },
  },
};

function installApiMock() {
  void mock.module("@/browser/contexts/API", () => ({
    useAPI: () => ({
      api: mockedApi,
      status: "connected" as const,
      error: null,
      authenticate: () => undefined,
      retry: () => undefined,
    }),
  }));
}

installApiMock();

import { useBrowserSessionSubscription as untypedUseBrowserSessionSubscription } from "./useBrowserSessionSubscription.ts?test-isolation=static";

const useBrowserSessionSubscription =
  untypedUseBrowserSessionSubscription as unknown as typeof UseBrowserSessionSubscription;

function isTimeoutCallback(handler: TimerHandler): handler is TimeoutCallback {
  return typeof handler === "function";
}

function createTimerControls() {
  let now = 0;
  let nextTimerId = 1;
  let installedGlobals: InstalledTimerGlobals | null = null;
  const timers = new Map<number, TimerRecord>();

  const syncWindowTimers = () => {
    if (typeof window === "undefined") {
      return;
    }

    window.setTimeout = globalThis.setTimeout;
    window.clearTimeout = globalThis.clearTimeout;
  };

  const findNextTimer = (targetTime: number) => {
    let nextTimerEntry: [number, TimerRecord] | null = null;
    for (const timerEntry of timers.entries()) {
      if (timerEntry[1].runAt > targetTime) {
        continue;
      }
      if (nextTimerEntry === null || timerEntry[1].runAt < nextTimerEntry[1].runAt) {
        nextTimerEntry = timerEntry;
      }
    }
    return nextTimerEntry;
  };

  return {
    advanceTimersByTime(ms: number) {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`advanceTimersByTime() requires a non-negative duration, received ${ms}`);
      }

      const targetTime = now + ms;
      while (true) {
        const nextTimerEntry = findNextTimer(targetTime);
        if (nextTimerEntry === null) {
          now = targetTime;
          return;
        }

        const [timerId, timer] = nextTimerEntry;
        timers.delete(timerId);
        now = timer.runAt;
        timer.callback();
      }
    },
    getTimerCount() {
      return timers.size;
    },
    install() {
      if (installedGlobals !== null) {
        throw new Error("Timer controls are already installed");
      }
      if (typeof window === "undefined") {
        throw new Error("Timer controls require a window before install()");
      }

      now = 0;
      nextTimerId = 1;
      timers.clear();
      installedGlobals = {
        clearTimeout: globalThis.clearTimeout,
        dateNow: Date.now,
        setTimeout: globalThis.setTimeout,
        windowClearTimeout: window.clearTimeout,
        windowSetTimeout: window.setTimeout,
      };

      globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (!isTimeoutCallback(handler)) {
          throw new TypeError("Tests only support function callbacks for setTimeout()");
        }

        const timerId = nextTimerId;
        nextTimerId += 1;
        const callback = handler;
        timers.set(timerId, {
          callback: () => {
            callback(...args);
          },
          runAt: now + Math.max(delay ?? 0, 0),
        });
        return timerId as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof globalThis.setTimeout;

      globalThis.clearTimeout = ((timerId: ReturnType<typeof setTimeout>) => {
        timers.delete(Number(timerId));
      }) as typeof globalThis.clearTimeout;

      Date.now = () => now;
      syncWindowTimers();
    },
    restore() {
      if (installedGlobals === null) {
        throw new Error("Timer controls are not installed");
      }

      globalThis.setTimeout = installedGlobals.setTimeout;
      globalThis.clearTimeout = installedGlobals.clearTimeout;
      Date.now = installedGlobals.dateNow;
      window.setTimeout = installedGlobals.windowSetTimeout;
      window.clearTimeout = installedGlobals.windowClearTimeout;
      timers.clear();
      now = 0;
      nextTimerId = 1;
      installedGlobals = null;
    },
  };
}

const timerControls = createTimerControls();

type MockSubscription = ReturnType<typeof createMockSubscription>;

function createMockSubscription() {
  let pendingResolve: ((value: IteratorResult<BrowserSessionEvent>) => void) | null = null;
  const queuedResults: Array<IteratorResult<BrowserSessionEvent>> = [];
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
    (_value?: unknown) => {
      closed = true;
      const doneResult = getDoneResult();
      resolveNext(doneResult);
      return Promise.resolve(doneResult);
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
  let subscribeCalls: Array<Parameters<BrowserSessionSubscribe>>;
  let subscriptions: MockSubscription[];

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    timerControls.install();

    subscriptions = [];
    subscribeCalls = [];
    subscribeMock = mock<BrowserSessionSubscribe>((input, options) => {
      subscribeCalls.push([input, options]);
      const subscription = createMockSubscription();
      subscriptions.push(subscription);
      return Promise.resolve(subscription.iterator);
    });
    currentSubscribeMock = subscribeMock;

    // Neighboring BrowserTab tests mock the API context globally.
    // Re-install this file's API mock before each test so the isolated hook import
    // always reads this test's fake client and timer controls.
    installApiMock();

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    cleanup();
    currentSubscribeMock = uninitializedSubscribeMock;
    timerControls.restore();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("subscribes on mount", async () => {
    renderHook(() => useBrowserSessionSubscription("workspace-1"));
    await flushEffects();

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeCalls).toHaveLength(1);
    const firstSubscribeCall = subscribeCalls[0];
    if (!firstSubscribeCall) {
      throw new Error("Expected the hook to subscribe on mount");
    }
    const [subscribeInput, subscribeOptions] = firstSubscribeCall;
    expect(subscribeInput).toEqual({ workspaceId: "workspace-1" });
    expect(subscribeOptions.signal).toBeInstanceOf(AbortSignal);
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
