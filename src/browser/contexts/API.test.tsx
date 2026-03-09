import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

// Mock WebSocket that we can control
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0; // CONNECTING
  eventListeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, handler: (event?: unknown) => void) {
    const handlers = this.eventListeners.get(event) ?? [];
    handlers.push(handler);
    this.eventListeners.set(event, handlers);
  }

  close() {
    this.readyState = 3; // CLOSED
  }

  // Test helpers
  simulateOpen() {
    this.readyState = 1; // OPEN
    this.eventListeners.get("open")?.forEach((h) => h());
  }

  simulateClose(code: number) {
    this.readyState = 3;
    this.eventListeners.get("close")?.forEach((h) => h({ code }));
  }

  simulateError() {
    this.eventListeners.get("error")?.forEach((h) => h());
  }
  simulateMessage(data: unknown = "data") {
    this.eventListeners.get("message")?.forEach((h) => h({ data }));
  }

  static reset() {
    MockWebSocket.instances = [];
  }

  static lastInstance(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
}

function createOrpcPongResponseFrame(id: number): string {
  return JSON.stringify({ i: id, p: { b: "pong" } });
}

const originalFetch = globalThis.fetch;
let fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = () =>
  Promise.resolve({
    ok: false,
    json: () => Promise.resolve({}),
  } as unknown as Response);

// Mock orpc client
let pingImpl: () => Promise<string> = () => Promise.resolve("pong");

void mock.module("@/common/orpc/client", () => ({
  createClient: () => ({
    general: {
      ping: () => pingImpl(),
    },
  }),
}));

void mock.module("@orpc/client/websocket", () => ({
  RPCLink: class {},
}));

void mock.module("@orpc/client/message-port", () => ({
  RPCLink: class {},
}));

void mock.module("@/browser/components/AuthTokenModal/AuthTokenModal", () => ({
  // Note: Module mocks leak between bun test files.
  // Export all commonly-used symbols to avoid cross-test import errors.
  AuthTokenModal: () => null,
  getStoredAuthToken: () => null,
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  setStoredAuthToken: () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  clearStoredAuthToken: () => {},
}));

// Import the real API module types (not the mocked version)
import type { UseAPIResult as _UseAPIResult, APIProvider as APIProviderType } from "./API";

// IMPORTANT: Other test files mock @/browser/contexts/API with a fake APIProvider.
// Module mocks leak between test files in bun (https://github.com/oven-sh/bun/issues/12823).
// The query string creates a distinct module cache key, bypassing any mocked version.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
const RealAPIModule: {
  APIProvider: typeof APIProviderType;
  useAPI: () => _UseAPIResult;
} = require("./API?real=1");
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
const { APIProvider, useAPI } = RealAPIModule;
type UseAPIResult = _UseAPIResult;

// Test component to observe API state
function APIStateObserver(props: { onState: (state: UseAPIResult) => void }) {
  const apiState = useAPI();
  props.onState(apiState);
  return null;
}

// Factory that creates MockWebSocket instances (injected via prop)
const createMockWebSocket = (url: string) => new MockWebSocket(url) as unknown as WebSocket;

describe("API reconnection", () => {
  beforeEach(() => {
    // Minimal DOM setup required by @testing-library/react.
    //
    // Happy DOM can default to an opaque origin ("null") in some modes (e.g. coverage).
    // That breaks URL construction in createBrowserClient(). Give it a stable http(s) origin.
    const happyWindow = new GlobalWindow({ url: "https://mux.example.com/" });
    globalThis.window = happyWindow as unknown as Window & typeof globalThis;
    globalThis.document = happyWindow.document as unknown as Document;
    fetchImpl = () =>
      Promise.resolve({
        ok: false,
        json: () => Promise.resolve({}),
      } as unknown as Response);

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      fetchImpl(input, init)) as typeof globalThis.fetch;
    MockWebSocket.reset();
    pingImpl = () => Promise.resolve("pong");
  });

  afterEach(() => {
    cleanup();
    MockWebSocket.reset();
    globalThis.fetch = originalFetch;
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("constructs WebSocket URL with app proxy prefix", () => {
    window.location.href = "https://coder.example.com/@u/ws/apps/mux/?token=abc";

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={() => undefined} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();
    expect(ws1!.url).toBe("wss://coder.example.com/@u/ws/apps/mux/orpc/ws?token=abc");
  });

  test("reconnects on close without showing auth_required when previously connected", async () => {
    const states: string[] = [];

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    // Simulate successful connection (open + ping success)
    await act(async () => {
      ws1!.simulateOpen();
      // Wait for ping promise to resolve
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(states).toContain("connected");

    // Simulate server restart (close code 1006 = abnormal closure)
    act(() => {
      ws1!.simulateClose(1006);
    });

    // Should be "reconnecting", NOT "auth_required"
    await waitFor(() => {
      expect(states).toContain("reconnecting");
    });

    expect(states.filter((s) => s === "auth_required")).toHaveLength(0);

    // New WebSocket should be created for reconnect attempt (after delay)
    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    });
  });

  test("shows auth_required on close with auth error codes (4401)", async () => {
    const states: string[] = [];

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    await act(async () => {
      ws1!.simulateOpen();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(states).toContain("connected");

    act(() => {
      ws1!.simulateClose(4401);
    });

    await waitFor(() => {
      expect(states).toContain("auth_required");
    });
  });

  test("shows auth_required on close with auth error codes (1008)", async () => {
    const states: string[] = [];

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    await act(async () => {
      ws1!.simulateOpen();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(states).toContain("connected");

    act(() => {
      ws1!.simulateClose(1008);
    });

    await waitFor(() => {
      expect(states).toContain("auth_required");
    });
  });

  test("retries on first connection failure without showing auth_required", async () => {
    const states: string[] = [];

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    // First connection fails - browser fires error then close.
    act(() => {
      ws1!.simulateError();
      ws1!.simulateClose(1006);
    });

    await waitFor(() => {
      expect(states).toContain("reconnecting");
    });

    expect(states.filter((s) => s === "auth_required")).toHaveLength(0);

    // Should create a new WebSocket for the reconnect attempt.
    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    });
  });

  test("shows auth_required when the WS handshake fails but /api/spec.json requires auth", async () => {
    const states: string[] = [];
    fetchImpl = async () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ security: [{ bearerAuth: [] }] }),
      } as unknown as Response);

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    act(() => {
      ws1!.simulateError();
      ws1!.simulateClose(1006);
    });

    await waitFor(() => {
      expect(states).toContain("auth_required");
    });

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  test("does not hang startup when /api/spec.json probe stalls (schedules reconnect after timeout)", async () => {
    const states: string[] = [];

    fetchImpl = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    act(() => {
      ws1!.simulateError();
      ws1!.simulateClose(1006);
    });

    await waitFor(
      () => {
        expect(states).toContain("reconnecting");
      },
      { timeout: 5000 }
    );

    await waitFor(
      () => {
        expect(MockWebSocket.instances.length).toBeGreaterThan(1);
      },
      { timeout: 5000 }
    );
  });

  test("re-probes /api/spec.json after an inconclusive result and then shows auth_required", async () => {
    const states: string[] = [];
    let probeCalls = 0;

    fetchImpl = async () => {
      probeCalls++;
      if (probeCalls === 1) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({}),
        } as unknown as Response);
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ security: [{ bearerAuth: [] }] }),
      } as unknown as Response);
    };

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    act(() => {
      ws1!.simulateError();
      ws1!.simulateClose(1006);
    });

    await waitFor(() => {
      expect(states).toContain("reconnecting");
    });

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    });

    const ws2 = MockWebSocket.lastInstance();
    expect(ws2).toBeDefined();
    expect(ws2).not.toBe(ws1);

    act(() => {
      ws2!.simulateError();
      ws2!.simulateClose(1006);
    });

    await waitFor(() => {
      expect(states).toContain("auth_required");
    });

    expect(probeCalls).toBeGreaterThanOrEqual(2);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  test("reconnects on connection loss when previously connected", async () => {
    const states: string[] = [];

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    await act(async () => {
      ws1!.simulateOpen();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(states).toContain("connected");

    // Connection lost after being connected
    act(() => {
      ws1!.simulateError();
      ws1!.simulateClose(1006);
    });

    await waitFor(() => {
      expect(states).toContain("reconnecting");
    });

    const authRequiredAfterConnected = states.slice(states.indexOf("connected") + 1);
    expect(authRequiredAfterConnected.filter((s) => s === "auth_required")).toHaveLength(0);
  });
  test(
    "treats active inbound traffic as healthy and skips liveness pings",
    async () => {
      let pingCallCount = 0;
      pingImpl = () => {
        pingCallCount++;
        return Promise.resolve("pong");
      };

      render(
        <APIProvider createWebSocket={createMockWebSocket}>
          <APIStateObserver onState={() => undefined} />
        </APIProvider>
      );

      const ws1 = MockWebSocket.lastInstance();
      expect(ws1).toBeDefined();

      await act(async () => {
        ws1!.simulateOpen();
        await new Promise((r) => setTimeout(r, 10));
      });

      // Initial auth-check ping should run once on connect.
      expect(pingCallCount).toBe(1);

      // Keep inbound traffic flowing so the provider can infer liveness without adding
      // more ping load to an already busy socket.
      const messageInterval = setInterval(() => {
        ws1!.simulateMessage({ type: "stream-delta" });
      }, 250);

      try {
        await new Promise((r) => setTimeout(r, 6200));
        expect(pingCallCount).toBe(1);
      } finally {
        clearInterval(messageInterval);
      }

      // Once traffic stops, periodic liveness pings should resume.
      await waitFor(
        () => {
          expect(pingCallCount).toBeGreaterThan(1);
        },
        { timeout: 6000 }
      );
    },
    { timeout: 15000 }
  );
  test(
    "counts stream traffic while liveness probes are in flight",
    async () => {
      let pingCallCount = 0;
      let isAuthCheck = true;

      pingImpl = () => {
        pingCallCount++;

        if (isAuthCheck) {
          isAuthCheck = false;
          return Promise.resolve("pong");
        }

        // Keep liveness probes pending long enough to overlap with the next interval.
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve("pong");
          }, 9000);
        });
      };

      render(
        <APIProvider createWebSocket={createMockWebSocket}>
          <APIStateObserver onState={() => undefined} />
        </APIProvider>
      );

      const ws1 = MockWebSocket.lastInstance();
      expect(ws1).toBeDefined();

      await act(async () => {
        ws1!.simulateOpen();
        await new Promise((r) => setTimeout(r, 10));
      });

      await waitFor(
        () => {
          expect(pingCallCount).toBeGreaterThanOrEqual(2);
        },
        { timeout: 7000 }
      );

      const pingCallsWhenProbeStarted = pingCallCount;

      const messageInterval = setInterval(() => {
        ws1!.simulateMessage({ type: "stream-delta" });
      }, 250);

      try {
        await new Promise((r) => setTimeout(r, 6000));
      } finally {
        clearInterval(messageInterval);
      }

      // Stream traffic during an in-flight probe should keep the connection healthy and
      // suppress additional liveness probes for the next interval.
      expect(pingCallCount).toBe(pingCallsWhenProbeStarted);
    },
    { timeout: 20000 }
  );

  test(
    "does not treat delayed liveness ping replies as stream traffic",
    async () => {
      const states: string[] = [];
      let pingCallCount = 0;
      let activeSocket: MockWebSocket | null = null;

      pingImpl = () => {
        pingCallCount++;

        // Simulate a slow liveness probe where the response arrives after timeout.
        // The delayed reply is emitted as a WS message to mimic network delivery.
        return new Promise((resolve) => {
          setTimeout(() => {
            activeSocket?.simulateMessage(createOrpcPongResponseFrame(pingCallCount));
            resolve("pong");
          }, 3500);
        });
      };

      render(
        <APIProvider createWebSocket={createMockWebSocket}>
          <APIStateObserver onState={(s) => states.push(s.status)} />
        </APIProvider>
      );

      const ws1 = MockWebSocket.lastInstance();
      expect(ws1).toBeDefined();
      activeSocket = ws1!;

      act(() => {
        ws1!.simulateOpen();
      });

      await waitFor(
        () => {
          expect(states).toContain("connected");
        },
        { timeout: 7000 }
      );

      const pingCallsAfterAuthCheck = pingCallCount;
      expect(pingCallsAfterAuthCheck).toBe(1);

      // Wait long enough for two liveness intervals. If delayed ping replies were counted
      // as stream traffic, the second interval would be skipped and this count would stay low.
      await new Promise((r) => setTimeout(r, 12000));
      expect(pingCallCount).toBeGreaterThanOrEqual(pingCallsAfterAuthCheck + 2);
    },
    { timeout: 25000 }
  );

  test("does not flicker into reconnecting when auth is rejected by ping", async () => {
    const states: string[] = [];
    pingImpl = () => Promise.reject(new Error("401 Unauthorized"));

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    await act(async () => {
      ws1!.simulateOpen();
      await new Promise((r) => setTimeout(r, 10));
    });

    await waitFor(() => {
      expect(states).toContain("auth_required");
    });

    // Simulate a close after we decided auth is required (cleanup closes the socket in real life).
    act(() => {
      ws1!.simulateClose(1000);
    });

    // Give state a chance to update if a reconnect was scheduled.
    await new Promise((r) => setTimeout(r, 25));

    expect(states.filter((s) => s === "reconnecting")).toHaveLength(0);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
