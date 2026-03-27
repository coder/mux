import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { log } from "@/node/services/log";
import { BrowserSessionStateHub, type PageState } from "./BrowserSessionStateHub";

const WORKSPACE_ID = "workspace-1";
const SESSION_NAME = "session-a";
const POLL_INTERVAL_MS = 50;
const CONDITION_TIMEOUT_MS = 1_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = CONDITION_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await Bun.sleep(10);
  }
}

afterEach(() => {
  mock.restore();
});

describe("BrowserSessionStateHub", () => {
  test("subscribe fetches and broadcasts the initial bootstrap snapshot", async () => {
    const getUrl = mock(() => Promise.resolve({ url: "https://example.com/bootstrap" }));
    const hub = new BrowserSessionStateHub({
      browserControlService: { getUrl },
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    const callback = mock(() => undefined);

    try {
      hub.subscribe(WORKSPACE_ID, SESSION_NAME, callback);
      await flushMicrotasks();

      expect(getUrl).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({
        type: "page_state",
        url: "https://example.com/bootstrap",
        isLoading: false,
        source: "bootstrap",
      });
    } finally {
      hub.dispose();
    }
  });

  test("multiple subscribers for the same session share one poller", async () => {
    let callCount = 0;
    const getUrl = mock(() => {
      callCount += 1;
      return Promise.resolve({
        url: callCount === 1 ? "https://example.com/initial" : "https://example.com/poll",
      });
    });
    const hub = new BrowserSessionStateHub({
      browserControlService: { getUrl },
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    const callbackA = mock(() => undefined);
    const callbackB = mock(() => undefined);

    try {
      hub.subscribe(WORKSPACE_ID, SESSION_NAME, callbackA);
      hub.subscribe(WORKSPACE_ID, SESSION_NAME, callbackB);
      await flushMicrotasks();

      expect(callCount).toBe(1);
      expect(callbackA).toHaveBeenCalledTimes(1);
      expect(callbackB).toHaveBeenCalledTimes(1);

      await waitForCondition(() => callCount === 2);

      expect(callbackA).toHaveBeenLastCalledWith({
        type: "page_state",
        url: "https://example.com/poll",
        isLoading: false,
        source: "poll",
      });
      expect(callbackB).toHaveBeenLastCalledWith({
        type: "page_state",
        url: "https://example.com/poll",
        isLoading: false,
        source: "poll",
      });
    } finally {
      hub.dispose();
    }
  });

  test("last subscriber unsubscribing stops the poller", async () => {
    let callCount = 0;
    const getUrl = mock(() => {
      callCount += 1;
      return Promise.resolve({ url: "https://example.com/initial" });
    });
    const hub = new BrowserSessionStateHub({
      browserControlService: { getUrl },
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    try {
      const unsubscribe = hub.subscribe(WORKSPACE_ID, SESSION_NAME, () => undefined);
      await flushMicrotasks();
      unsubscribe();

      await Bun.sleep(POLL_INTERVAL_MS * 3);

      expect(callCount).toBe(1);
    } finally {
      hub.dispose();
    }
  });

  test("markLoading broadcasts an in-flight command state", async () => {
    const bootstrap = createDeferred<{ url: string | null; error?: string }>();
    const getUrl = mock(() => bootstrap.promise);
    const hub = new BrowserSessionStateHub({
      browserControlService: { getUrl },
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    const states: PageState[] = [];

    try {
      hub.subscribe(WORKSPACE_ID, SESSION_NAME, (state) => {
        states.push(state);
      });
      hub.markLoading(WORKSPACE_ID, SESSION_NAME);

      expect(states).toEqual([
        {
          type: "page_state",
          url: null,
          isLoading: true,
          source: "command",
        },
      ]);

      bootstrap.resolve({ url: "https://example.com/bootstrap" });
      await flushMicrotasks();
    } finally {
      hub.dispose();
    }
  });

  test("markLoaded broadcasts the final command state", async () => {
    const bootstrap = createDeferred<{ url: string | null; error?: string }>();
    const getUrl = mock(() => bootstrap.promise);
    const hub = new BrowserSessionStateHub({
      browserControlService: { getUrl },
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    const states: PageState[] = [];

    try {
      hub.subscribe(WORKSPACE_ID, SESSION_NAME, (state) => {
        states.push(state);
      });
      hub.markLoaded(WORKSPACE_ID, SESSION_NAME, "https://example.com/loaded");

      expect(states).toEqual([
        {
          type: "page_state",
          url: "https://example.com/loaded",
          isLoading: false,
          source: "command",
        },
      ]);

      bootstrap.resolve({ url: "https://example.com/bootstrap" });
      await flushMicrotasks();
    } finally {
      hub.dispose();
    }
  });

  test("throwing subscribers do not prevent later subscribers from receiving updates", async () => {
    const bootstrap = createDeferred<{ url: string | null; error?: string }>();
    const getUrl = mock(() => bootstrap.promise);
    const warn = spyOn(log, "warn").mockImplementation(() => undefined);
    const hub = new BrowserSessionStateHub({
      browserControlService: { getUrl },
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    const throwingCallback = mock(() => {
      throw new Error("subscriber failed");
    });
    const secondCallback = mock(() => undefined);

    try {
      hub.subscribe(WORKSPACE_ID, SESSION_NAME, throwingCallback);
      hub.subscribe(WORKSPACE_ID, SESSION_NAME, secondCallback);

      expect(() => {
        hub.markLoaded(WORKSPACE_ID, SESSION_NAME, "https://example.com/loaded");
      }).not.toThrow();

      expect(throwingCallback).toHaveBeenCalledTimes(1);
      expect(secondCallback).toHaveBeenCalledTimes(1);
      expect(secondCallback).toHaveBeenCalledWith({
        type: "page_state",
        url: "https://example.com/loaded",
        isLoading: false,
        source: "command",
      });
      expect(warn).toHaveBeenCalledWith(
        "BrowserSessionStateHub: subscriber callback failed",
        expect.objectContaining({
          sessionKey: `${WORKSPACE_ID}:${SESSION_NAME}`,
        })
      );

      bootstrap.resolve({ url: "https://example.com/bootstrap" });
      await flushMicrotasks();
    } finally {
      hub.dispose();
    }
  });

  test("stalled polls are timed out so later polls can recover", async () => {
    const stalePoll = createDeferred<{ url: string | null; error?: string }>();
    const warn = spyOn(log, "warn").mockImplementation(() => undefined);
    let callCount = 0;
    const getUrl = mock(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({ url: "https://example.com/bootstrap" });
      }
      if (callCount === 2) {
        return stalePoll.promise;
      }
      return Promise.resolve({ url: "https://example.com/recovered" });
    });
    const hub = new BrowserSessionStateHub({
      browserControlService: { getUrl },
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    const states: PageState[] = [];

    try {
      hub.subscribe(WORKSPACE_ID, SESSION_NAME, (state) => {
        states.push(state);
      });
      await flushMicrotasks();
      await waitForCondition(() => callCount === 2);
      await waitForCondition(() => callCount >= 3);
      await waitForCondition(() => states.length === 2);

      expect(states).toEqual([
        {
          type: "page_state",
          url: "https://example.com/bootstrap",
          isLoading: false,
          source: "bootstrap",
        },
        {
          type: "page_state",
          url: "https://example.com/recovered",
          isLoading: false,
          source: "poll",
        },
      ]);
      expect(warn).toHaveBeenCalledWith(
        "BrowserSessionStateHub: poll timed out, clearing pollInFlight",
        expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          sessionName: SESSION_NAME,
          sessionKey: `${WORKSPACE_ID}:${SESSION_NAME}`,
        })
      );

      stalePoll.resolve({ url: "https://example.com/stale" });
      await flushMicrotasks();

      expect(states).toEqual([
        {
          type: "page_state",
          url: "https://example.com/bootstrap",
          isLoading: false,
          source: "bootstrap",
        },
        {
          type: "page_state",
          url: "https://example.com/recovered",
          isLoading: false,
          source: "poll",
        },
      ]);
    } finally {
      hub.dispose();
    }
  });

  test("stale poll results are discarded after a newer command update", async () => {
    const stalePoll = createDeferred<{ url: string | null; error?: string }>();
    let callCount = 0;
    const getUrl = mock(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({ url: "https://example.com/initial" });
      }
      return stalePoll.promise;
    });
    const hub = new BrowserSessionStateHub({
      browserControlService: { getUrl },
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    const states: PageState[] = [];

    try {
      hub.subscribe(WORKSPACE_ID, SESSION_NAME, (state) => {
        states.push(state);
      });
      await flushMicrotasks();
      await waitForCondition(() => callCount === 2);

      hub.markLoaded(WORKSPACE_ID, SESSION_NAME, "https://example.com/current");
      stalePoll.resolve({ url: "https://example.com/stale" });
      await flushMicrotasks();

      expect(states).toEqual([
        {
          type: "page_state",
          url: "https://example.com/initial",
          isLoading: false,
          source: "bootstrap",
        },
        {
          type: "page_state",
          url: "https://example.com/current",
          isLoading: false,
          source: "command",
        },
      ]);
    } finally {
      hub.dispose();
    }
  });

  test("poll errors are logged and later polls continue", async () => {
    let warnCount = 0;
    spyOn(log, "warn").mockImplementation(() => {
      warnCount += 1;
      return undefined;
    });
    let callCount = 0;
    const getUrl = mock(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({ url: "https://example.com/bootstrap" });
      }
      if (callCount === 2) {
        return Promise.resolve({ url: null, error: "poll failed" });
      }
      return Promise.resolve({ url: "https://example.com/recovered" });
    });
    const hub = new BrowserSessionStateHub({
      browserControlService: { getUrl },
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    const states: PageState[] = [];

    try {
      hub.subscribe(WORKSPACE_ID, SESSION_NAME, (state) => {
        states.push(state);
      });
      await flushMicrotasks();
      await waitForCondition(() => warnCount === 1);
      await waitForCondition(() => states.length === 2);

      expect(states).toEqual([
        {
          type: "page_state",
          url: "https://example.com/bootstrap",
          isLoading: false,
          source: "bootstrap",
        },
        {
          type: "page_state",
          url: "https://example.com/recovered",
          isLoading: false,
          source: "poll",
        },
      ]);
    } finally {
      hub.dispose();
    }
  });

  test("dispose clears all pollers and stops further refreshes", async () => {
    let callCount = 0;
    const getUrl = mock(() => {
      callCount += 1;
      return Promise.resolve({ url: "https://example.com/bootstrap" });
    });
    const hub = new BrowserSessionStateHub({
      browserControlService: { getUrl },
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    hub.subscribe(WORKSPACE_ID, SESSION_NAME, () => undefined);
    hub.subscribe(WORKSPACE_ID, "session-b", () => undefined);
    await flushMicrotasks();
    expect(callCount).toBe(2);

    hub.dispose();
    await Bun.sleep(POLL_INTERVAL_MS * 3);

    expect(callCount).toBe(2);
  });
});
