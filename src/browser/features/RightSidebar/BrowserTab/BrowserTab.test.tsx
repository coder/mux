import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { BrowserSession } from "./browserBridgeTypes";

let mockSession: BrowserSession | null = null;
const connectMock = mock();
const sendInputMock = mock();

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {},
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("./useBrowserBridgeConnection", () => ({
  useBrowserBridgeConnection: () => ({
    session: mockSession,
    connect: connectMock,
    sendInput: sendInputMock,
  }),
}));

import { BrowserTab } from "./BrowserTab";

function createSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    status: "live",
    frameBase64: null,
    lastError: null,
    streamState: "live",
    frameMetadata: null,
    streamErrorMessage: null,
    ...overrides,
  };
}

const intervalCallbacks: Array<() => void> = [];
let originalSetInterval: typeof globalThis.setInterval;
let originalClearInterval: typeof globalThis.clearInterval;

describe("BrowserTab", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;
    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    intervalCallbacks.length = 0;
    globalThis.setInterval = ((callback: TimerHandler) => {
      if (typeof callback !== "function") {
        throw new TypeError("Tests only support function callbacks for setInterval()");
      }
      intervalCallbacks.push(callback as () => void);
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof globalThis.setInterval;
    globalThis.clearInterval = (() => undefined) as typeof globalThis.clearInterval;
    mockSession = null;
    connectMock.mockReset();
    sendInputMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  test("auto-starts the browser preview on first mount", () => {
    render(<BrowserTab workspaceId="workspace-1" />);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  test("keeps polling while waiting for a browser session to appear", () => {
    render(<BrowserTab workspaceId="workspace-1" />);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(intervalCallbacks).toHaveLength(1);

    intervalCallbacks[0]();

    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  test("reconnects automatically when the browser session is unavailable", () => {
    mockSession = createSession({
      status: "error",
      streamState: "error",
      lastError: "disconnected",
    });

    render(<BrowserTab workspaceId="workspace-1" />);

    expect(connectMock).toHaveBeenCalledTimes(0);
    expect(intervalCallbacks).toHaveLength(1);

    intervalCallbacks[0]();

    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  test("does not keep retrying fatal startup errors", () => {
    mockSession = createSession({
      status: "error",
      streamState: "error",
      lastError: "Vendored agent-browser binary not found",
    });

    render(<BrowserTab workspaceId="workspace-1" />);

    expect(connectMock).toHaveBeenCalledTimes(0);
    expect(intervalCallbacks).toHaveLength(0);
  });

  test("does not render manual start or stop controls", () => {
    mockSession = createSession();
    const view = render(<BrowserTab workspaceId="workspace-1" />);

    expect(view.queryByRole("button", { name: "Start" })).toBeNull();
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(view.queryByRole("button", { name: "Restart" })).toBeNull();
  });

  test("shows a visible error when the bridge session fails", () => {
    mockSession = createSession({
      status: "error",
      lastError: "bridge exploded",
      streamState: "error",
    });
    const view = render(<BrowserTab workspaceId="workspace-1" />);
    expect(view.getByRole("alert").textContent).toContain("bridge exploded");
  });
});
