import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

const getBootstrapMock = mock(() =>
  Promise.resolve({
    bridgePath: "/browser/ws",
    token: "token-1",
    localBridgeBaseUrl: "http://localhost:8123",
  })
);

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      browser: {
        getBootstrap: getBootstrapMock,
      },
    },
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

import type { useBrowserBridgeConnection as UseBrowserBridgeConnection } from "./useBrowserBridgeConnection";
import { useBrowserBridgeConnection as untypedUseBrowserBridgeConnection } from "./useBrowserBridgeConnection.ts?test-isolation=static";

const useBrowserBridgeConnection =
  untypedUseBrowserBridgeConnection as unknown as typeof UseBrowserBridgeConnection;

interface FakeWebSocketEvent {
  data?: string;
  code?: number;
  reason?: string;
}

type FakeWebSocketListener = (event: FakeWebSocketEvent) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  readonly send = mock();
  private readonly listeners = new Map<string, Set<FakeWebSocketListener>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: FakeWebSocketListener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeWebSocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(type: string, event: FakeWebSocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code: 1000, reason: "" });
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  emitMessage(payload: unknown) {
    this.dispatch("message", { data: JSON.stringify(payload) });
  }

  emitClose(code: number, reason: string) {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code, reason });
  }
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useBrowserBridgeConnection", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalWebSocket = globalThis.WebSocket;
    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket;
    window.WebSocket = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    getBootstrapMock.mockReset();
    getBootstrapMock.mockResolvedValue({
      bridgePath: "/browser/ws",
      token: "token-1",
      localBridgeBaseUrl: "http://localhost:8123",
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.WebSocket = originalWebSocket;
  });

  test("bootstraps the mux bridge and surfaces live frame state", async () => {
    const { result } = renderHook(() => useBrowserBridgeConnection("workspace-1"));

    act(() => {
      result.current.connect("session-a");
    });
    await flushAsyncWork();

    const socket = FakeWebSocket.instances.at(-1)!;
    expect(getBootstrapMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionName: "session-a",
    });
    expect(socket.url).toBe("ws://localhost/browser/ws?token=token-1");

    act(() => {
      socket.open();
      socket.emitMessage({
        type: "frame",
        data: "abc123",
        metadata: {
          deviceWidth: 1280,
          deviceHeight: 720,
          pageScaleFactor: 1,
          offsetTop: 0,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
      });
    });
    await flushAsyncWork();

    expect(result.current.session?.status).toBe("live");
    expect(result.current.session?.sessionName).toBe("session-a");
    expect(result.current.session?.frameBase64).toBe("abc123");
    expect(result.current.session?.frameMetadata?.deviceWidth).toBe(1280);
  });

  test("disconnect resets the local session state", async () => {
    const { result } = renderHook(() => useBrowserBridgeConnection("workspace-1"));

    act(() => {
      result.current.connect("session-a");
    });
    await flushAsyncWork();

    act(() => {
      result.current.disconnect();
    });
    await flushAsyncWork();

    expect(result.current.session).toBeNull();
  });

  test("surfaces close errors from the bridged socket", async () => {
    const { result } = renderHook(() => useBrowserBridgeConnection("workspace-1"));

    act(() => {
      result.current.connect("session-a");
    });
    await flushAsyncWork();

    const socket = FakeWebSocket.instances.at(-1)!;
    act(() => {
      socket.emitClose(1011, "bridge exploded");
    });
    await flushAsyncWork();

    expect(result.current.session?.status).toBe("error");
    expect(result.current.session?.lastError).toBe("bridge exploded");
  });
});
