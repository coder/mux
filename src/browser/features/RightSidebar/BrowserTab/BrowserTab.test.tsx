import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { BrowserSession } from "./browserBridgeTypes";

let mockSession: BrowserSession | null = null;
const connectMock = mock();
const disconnectMock = mock();
const sendInputMock = mock();
const stopMock = mock(() => Promise.resolve({ success: true }));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      browser: {
        stop: stopMock,
      },
    },
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
    disconnect: disconnectMock,
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

describe("BrowserTab", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    mockSession = null;
    connectMock.mockReset();
    disconnectMock.mockReset();
    sendInputMock.mockReset();
    stopMock.mockReset();
    stopMock.mockImplementation(() => Promise.resolve({ success: true }));
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("auto-starts the browser preview on first mount", () => {
    render(<BrowserTab workspaceId="workspace-1" />);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  test("stops the browser preview through the control plane", async () => {
    mockSession = createSession();
    const view = render(<BrowserTab workspaceId="workspace-1" />);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Stop" }));
      await Promise.resolve();
    });

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(stopMock).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
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
