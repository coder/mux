import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
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

  static reset() {
    MockWebSocket.instances = [];
  }

  static lastInstance(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
}

// Mock orpc client
void mock.module("@/common/orpc/client", () => ({
  createClient: () => ({
    general: {
      ping: () => Promise.resolve("pong"),
    },
  }),
}));

void mock.module("@orpc/client/websocket", () => ({
  RPCLink: class {},
}));

void mock.module("@orpc/client/message-port", () => ({
  RPCLink: class {},
}));

void mock.module("@/browser/components/AuthTokenModal", () => ({
  getStoredAuthToken: () => null,
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  clearStoredAuthToken: () => {},
}));

// Import after mocks
import { APIProvider, useAPI, type UseAPIResult } from "./API";

// Test component to observe API state
function APIStateObserver(props: { onState: (state: UseAPIResult) => void }) {
  const apiState = useAPI();
  props.onState(apiState);
  return null;
}

describe("API reconnection", () => {
  let originalConsoleError: typeof console.error;
  let originalWebSocket: typeof WebSocket;

  beforeAll(() => {
    // Store originals for restoration
    originalConsoleError = globalThis.console.error;
    originalWebSocket = globalThis.WebSocket;
    // Suppress console errors from React during tests
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    globalThis.console.error = () => {};
  });

  afterAll(() => {
    // Restore originals
    globalThis.console.error = originalConsoleError;
    globalThis.WebSocket = originalWebSocket;
  });

  beforeEach(() => {
    const happyWindow = new GlobalWindow();
    // Create a window object that mimics browser environment (not Electron)
    const mockWindow = Object.assign(happyWindow, {
      location: { origin: "http://localhost:3000", search: "" },
      WebSocket: MockWebSocket,
    });
    globalThis.window = mockWindow as unknown as Window & typeof globalThis;
    globalThis.document = happyWindow.document as unknown as Document;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    // Explicitly delete window.api to ensure we're not in Electron mode
    // (other tests may have set this on the global)
    delete (globalThis.window as unknown as Record<string, unknown>).api;
    MockWebSocket.reset();
  });

  afterEach(() => {
    cleanup();
    MockWebSocket.reset();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("reconnects on close without showing auth_required when previously connected", async () => {
    const states: string[] = [];

    render(
      <APIProvider>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    // Initial connection
    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    // Simulate successful connection (open + ping success)
    await act(async () => {
      ws1!.simulateOpen();
      // Wait for ping promise to resolve
      await new Promise((r) => setTimeout(r, 10));
    });

    // Should be connected
    expect(states).toContain("connected");

    // Simulate server restart (close code 1006 = abnormal closure)
    act(() => {
      ws1!.simulateClose(1006);
    });

    // Should be "reconnecting", NOT "auth_required"
    await waitFor(() => {
      expect(states).toContain("reconnecting");
    });

    // Verify auth_required was never set
    expect(states.filter((s) => s === "auth_required")).toHaveLength(0);

    // New WebSocket should be created for reconnect attempt (after delay)
    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    });
  });

  test("shows auth_required on close with auth error codes (4401)", async () => {
    const states: string[] = [];

    render(
      <APIProvider>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    // Simulate successful connection then auth rejection
    await act(async () => {
      ws1!.simulateOpen();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(states).toContain("connected");

    act(() => {
      ws1!.simulateClose(4401); // Auth required code
    });

    await waitFor(() => {
      expect(states).toContain("auth_required");
    });
  });

  test("shows auth_required on close with auth error codes (1008)", async () => {
    const states: string[] = [];

    render(
      <APIProvider>
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
      ws1!.simulateClose(1008); // Policy violation (auth)
    });

    await waitFor(() => {
      expect(states).toContain("auth_required");
    });
  });

  test("shows auth_required on first connection failure without token", async () => {
    const states: string[] = [];

    render(
      <APIProvider>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    // First connection fails (server not up, no previous connection)
    // Browser fires error then close - we simulate both
    act(() => {
      ws1!.simulateError();
      ws1!.simulateClose(1006); // Abnormal closure
    });

    await waitFor(() => {
      expect(states).toContain("auth_required");
    });

    // Should not attempt reconnect on first failure
    expect(states.filter((s) => s === "reconnecting")).toHaveLength(0);
  });

  test("reconnects on connection loss when previously connected", async () => {
    const states: string[] = [];

    render(
      <APIProvider>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    // Successful connection first
    await act(async () => {
      ws1!.simulateOpen();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(states).toContain("connected");

    // Connection lost after being connected (error + close)
    act(() => {
      ws1!.simulateError();
      ws1!.simulateClose(1006); // Abnormal closure
    });

    await waitFor(() => {
      expect(states).toContain("reconnecting");
    });

    // Should not show auth_required
    const authRequiredAfterConnected = states.slice(states.indexOf("connected") + 1);
    expect(authRequiredAfterConnected.filter((s) => s === "auth_required")).toHaveLength(0);
  });
});
