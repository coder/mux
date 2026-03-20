import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import {
  BrowserTab,
  BROWSER_PREVIEW_RETRY_INTERVAL_MS,
  shouldBackOffBrowserReconnect,
} from "./BrowserTab";
import type { BrowserDiscoveredSession, BrowserSession } from "./browserBridgeTypes";

let mockSession: BrowserSession | null = null;
let mockDiscoveredSessions: BrowserDiscoveredSession[] = [];
const connectMock = mock();
const disconnectMock = mock();
const sendInputMock = mock();
const listSessionsMock = mock(() => Promise.resolve({ sessions: mockDiscoveredSessions }));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      browser: {
        listSessions: listSessionsMock,
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

function createSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    sessionName: "alpha",
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

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let nextProjectPathId = 0;

describe("BrowserTab", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let projectPath: string;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;
    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    projectPath = `/tmp/project-${nextProjectPathId}`;
    nextProjectPathId += 1;
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
    mockDiscoveredSessions = [];
    connectMock.mockReset();
    disconnectMock.mockReset();
    sendInputMock.mockReset();
    listSessionsMock.mockReset();
    listSessionsMock.mockImplementation(() =>
      Promise.resolve({ sessions: mockDiscoveredSessions })
    );
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  test("shows a passive waiting state when no sessions are discovered", async () => {
    const view = render(<BrowserTab workspaceId="workspace-1" projectPath={projectPath} />);
    await flushAsyncWork();

    expect(connectMock).not.toHaveBeenCalled();
    expect(view.getByText("Waiting for browser preview")).toBeTruthy();
    expect(view.getByText(/agent-owned browser session/i)).toBeTruthy();
  });

  test("auto-selects and attaches to the only attachable session", async () => {
    mockDiscoveredSessions = [{ sessionName: "alpha", status: "attachable" }];

    render(<BrowserTab workspaceId="workspace-1" projectPath={projectPath} />);
    await flushAsyncWork();

    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith("alpha");
    });
  });

  test("surfaces missing-stream sessions without attempting to connect", async () => {
    mockDiscoveredSessions = [{ sessionName: "testing", status: "missing_stream" }];

    const view = render(<BrowserTab workspaceId="workspace-1" projectPath={projectPath} />);
    await flushAsyncWork();

    expect(connectMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(view.getByText("Browser preview requires streaming")).toBeTruthy();
      expect(view.getByRole("alert").textContent).toContain("AGENT_BROWSER_STREAM_PORT");
      expect(view.getByRole("button", { name: /testing/i })).toBeTruthy();
    });
  });

  test("renders a session picker when multiple sessions are discovered", async () => {
    mockDiscoveredSessions = [
      { sessionName: "alpha", status: "attachable" },
      { sessionName: "beta", status: "attachable" },
    ];

    const view = render(<BrowserTab workspaceId="workspace-1" projectPath={projectPath} />);
    await flushAsyncWork();

    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith("alpha");
    });

    fireEvent.click(view.getByRole("button", { name: /alpha/i }));
    fireEvent.click(view.getByTestId("browser-session-beta"));
    await flushAsyncWork();

    await waitFor(() => {
      expect(connectMock).toHaveBeenLastCalledWith("beta");
    });
  });

  test("lets the user select a missing-stream session from the picker", async () => {
    mockDiscoveredSessions = [
      { sessionName: "alpha", status: "attachable" },
      { sessionName: "testing", status: "missing_stream" },
    ];
    mockSession = createSession({ sessionName: "alpha" });

    const view = render(<BrowserTab workspaceId="workspace-1" projectPath={projectPath} />);
    await flushAsyncWork();

    await waitFor(() => {
      expect(view.getByRole("button", { name: /alpha/i })).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: /alpha/i }));
    fireEvent.click(view.getByTestId("browser-session-testing"));
    await flushAsyncWork();

    await waitFor(() => {
      expect(disconnectMock).toHaveBeenCalled();
      expect(view.getByRole("alert").textContent).toContain('Session "testing"');
      expect(view.getByText("Browser preview requires streaming")).toBeTruthy();
    });
  });

  test("remembers the last selected browser session across remounts", async () => {
    mockDiscoveredSessions = [
      { sessionName: "alpha", status: "attachable" },
      { sessionName: "beta", status: "attachable" },
    ];

    const firstRender = render(<BrowserTab workspaceId="workspace-1" projectPath={projectPath} />);
    await flushAsyncWork();

    await waitFor(() => {
      expect(firstRender.getByRole("button", { name: /alpha/i })).toBeTruthy();
    });

    fireEvent.click(firstRender.getByRole("button", { name: /alpha/i }));
    fireEvent.click(firstRender.getByTestId("browser-session-beta"));
    await flushAsyncWork();
    await waitFor(() => {
      expect(connectMock).toHaveBeenLastCalledWith("beta");
    });

    firstRender.unmount();
    connectMock.mockReset();
    disconnectMock.mockReset();

    render(<BrowserTab workspaceId="workspace-1" projectPath={projectPath} />);
    await flushAsyncWork();

    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith("beta");
    });
  });

  test("retries the selected discovered session after disconnect errors", async () => {
    mockDiscoveredSessions = [{ sessionName: "alpha", status: "attachable" }];
    mockSession = createSession({
      sessionName: "alpha",
      status: "error",
      streamState: "error",
      lastError: "disconnected",
    });

    render(<BrowserTab workspaceId="workspace-1" projectPath={projectPath} />);
    await flushAsyncWork();

    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith("alpha");
    });
  });

  test("preserves the current browser attachment when discovery refreshes fail", async () => {
    mockDiscoveredSessions = [{ sessionName: "alpha", status: "attachable" }];
    let discoveryCallCount = 0;
    listSessionsMock.mockReset();
    listSessionsMock.mockImplementation(() => {
      discoveryCallCount += 1;
      if (discoveryCallCount === 1) {
        return Promise.resolve({ sessions: mockDiscoveredSessions });
      }

      return Promise.reject(new Error("discovery exploded"));
    });

    const view = render(<BrowserTab workspaceId="workspace-1" projectPath={projectPath} />);
    await flushAsyncWork();

    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith("alpha");
    });
    disconnectMock.mockReset();

    await act(async () => {
      intervalCallbacks[0]?.();
      await Promise.resolve();
    });
    await flushAsyncWork();

    await waitFor(() => {
      expect(disconnectMock).not.toHaveBeenCalled();
      expect(view.getByRole("button", { name: /alpha/i })).toBeTruthy();
    });
  });

  test("backs off reconnect attempts after immediate bootstrap failures", () => {
    expect(
      shouldBackOffBrowserReconnect({
        selectedSessionName: "alpha",
        session: createSession({
          sessionName: "alpha",
          status: "error",
          streamState: "error",
          lastError: "disconnected",
        }),
        visibleError: "disconnected",
        lastConnectAttempt: {
          sessionName: "alpha",
          attemptedAtMs: 10_000,
        },
        nowMs: 10_000 + BROWSER_PREVIEW_RETRY_INTERVAL_MS - 1,
      })
    ).toBe(true);

    expect(
      shouldBackOffBrowserReconnect({
        selectedSessionName: "alpha",
        session: createSession({
          sessionName: "alpha",
          status: "error",
          streamState: "error",
          lastError: "disconnected",
        }),
        visibleError: "disconnected",
        lastConnectAttempt: {
          sessionName: "alpha",
          attemptedAtMs: 10_000,
        },
        nowMs: 10_000 + BROWSER_PREVIEW_RETRY_INTERVAL_MS,
      })
    ).toBe(false);
  });

  test("does not overlap discovery refresh requests", async () => {
    let resolveFirstRequest: ((value: { sessions: BrowserDiscoveredSession[] }) => void) | null =
      null;
    listSessionsMock.mockReset();
    listSessionsMock.mockImplementation(
      () =>
        new Promise<{ sessions: BrowserDiscoveredSession[] }>((resolve) => {
          resolveFirstRequest = resolve;
        })
    );

    render(<BrowserTab workspaceId="workspace-1" projectPath={projectPath} />);
    await Promise.resolve();

    expect(listSessionsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      intervalCallbacks[0]?.();
      await Promise.resolve();
    });

    expect(listSessionsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstRequest?.({ sessions: [] });
      await Promise.resolve();
    });
    await flushAsyncWork();
  });

  test("does not render manual start or stop controls", async () => {
    mockDiscoveredSessions = [{ sessionName: "alpha", status: "attachable" }];
    mockSession = createSession();
    const view = render(<BrowserTab workspaceId="workspace-1" projectPath={projectPath} />);
    await flushAsyncWork();

    expect(view.queryByRole("button", { name: "Start" })).toBeNull();
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(view.queryByRole("button", { name: "Restart" })).toBeNull();
  });

  test("shows a visible error when the bridge session fails", async () => {
    mockDiscoveredSessions = [{ sessionName: "alpha", status: "attachable" }];
    mockSession = createSession({
      status: "error",
      lastError: "bridge exploded",
      streamState: "error",
    });
    const view = render(<BrowserTab workspaceId="workspace-1" projectPath={projectPath} />);
    await flushAsyncWork();

    expect(view.getByRole("alert").textContent).toContain("bridge exploded");
  });
});
