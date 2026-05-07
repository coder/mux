import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { useState } from "react";

import type {
  BrowserDiscoveredOtherSession,
  BrowserDiscoveredSession,
  BrowserSession,
} from "./browserBridgeTypes";

const listSessionsMock = mock(() =>
  Promise.resolve({
    sessions: [] as BrowserDiscoveredSession[],
    otherSessions: [] as BrowserDiscoveredOtherSession[],
  })
);
const connectMock = mock(() => undefined);
const disconnectMock = mock(() => undefined);
const sendInputMock = mock(() => undefined);
const setPendingUrlMock = mock(() => undefined);
let mockSession: BrowserSession | null = null;

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

void mock.module("@/browser/hooks/usePersistedState", () => ({
  usePersistedState: <T,>(_key: string, initialValue: T) => useState(initialValue),
}));

void mock.module("./useBrowserBridgeConnection", () => ({
  useBrowserBridgeConnection: () => ({
    session: mockSession,
    connect: connectMock,
    disconnect: disconnectMock,
    sendInput: sendInputMock,
    setPendingUrl: setPendingUrlMock,
  }),
}));

import {
  BROWSER_PREVIEW_RETRY_INTERVAL_MS,
  BrowserTab,
  chooseExplicitOtherSession,
  shouldBackOffBrowserReconnect,
} from "./BrowserTab";

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
    currentUrl: null,
    isPageLoading: false,
    pendingUrl: null,
    streamErrorMessage: null,
    ...overrides,
  };
}

function createDiscoveredSession(
  overrides: Partial<BrowserDiscoveredSession> = {}
): BrowserDiscoveredSession {
  return {
    sessionName: "alpha",
    status: "attachable",
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

    listSessionsMock.mockReset();
    listSessionsMock.mockResolvedValue({ sessions: [], otherSessions: [] });
    connectMock.mockReset();
    disconnectMock.mockReset();
    setPendingUrlMock.mockReset();
    sendInputMock.mockReset();
    mockSession = null;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("connects to missing_stream sessions while showing the activating state", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [createDiscoveredSession({ status: "missing_stream" })],
      otherSessions: [],
    });

    const view = render(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith("alpha");
    });

    expect(view.getByText("Activating")).toBeTruthy();
    expect(view.getByText("Starting live preview…")).toBeTruthy();
    expect(view.getByText('Enabling streaming for session "alpha"…')).toBeTruthy();
    expect(view.queryByText(/AGENT_BROWSER_STREAM_PORT/)).toBeNull();
  });

  test("shows other running sessions in the session picker without auto-attaching", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [],
      otherSessions: [
        {
          sessionName: "other-alpha",
          status: "attachable",
          cwd: "/tmp/other-project",
        },
      ],
    });

    const view = render(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect(view.getByText("Select session")).toBeTruthy();
    });
    expect(view.getByText("Choose a browser session")).toBeTruthy();
    expect(view.getByText("Select another session from the picker to connect.")).toBeTruthy();

    fireEvent.click(view.getByText("Select session"));

    expect(view.getByText("Other sessions")).toBeTruthy();
    expect(view.getByText("other-alpha")).toBeTruthy();
    expect(view.getByText("/tmp/other-project")).toBeTruthy();
    expect(connectMock).not.toHaveBeenCalled();
  });

  test("auto-selects current sessions while still listing other sessions in the picker", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [createDiscoveredSession({ sessionName: "current-alpha" })],
      otherSessions: [
        {
          sessionName: "other-alpha",
          status: "attachable",
          cwd: "/tmp/other-project",
        },
      ],
    });

    const view = render(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith("current-alpha");
    });

    fireEvent.click(view.getByText("current-alpha"));

    expect(view.getByTestId("browser-session-current-alpha")).toBeTruthy();
    expect(view.getByTestId("browser-other-session-other-alpha")).toBeTruthy();
  });

  test("can switch from an explicitly selected other session back to a current session", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [createDiscoveredSession({ sessionName: "current-alpha" })],
      otherSessions: [
        {
          sessionName: "other-alpha",
          status: "attachable",
          cwd: "/tmp/other-project",
        },
      ],
    });

    const view = render(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith("current-alpha");
    });

    fireEvent.click(view.getByText("current-alpha"));
    fireEvent.click(view.getByTestId("browser-other-session-other-alpha"));

    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith("other-alpha", {
        allowOtherWorkspaceSession: true,
      });
    });

    fireEvent.click(view.getByText("other-alpha"));
    fireEvent.click(view.getByTestId("browser-session-current-alpha"));

    await waitFor(() => {
      expect(connectMock.mock.calls.at(-1)).toEqual(["current-alpha"]);
    });
  });

  test("attaches to an other running session only after selecting it from the picker", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [],
      otherSessions: [
        {
          sessionName: "other-alpha",
          status: "attachable",
          cwd: "/tmp/other-project",
        },
      ],
    });

    const view = render(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect(view.getByText("Select session")).toBeTruthy();
    });

    fireEvent.click(view.getByText("Select session"));
    fireEvent.click(view.getByTestId("browser-other-session-other-alpha"));

    await waitFor(() => {
      expect(view.getByText("Waiting for browser frames")).toBeTruthy();
    });

    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith("other-alpha", {
        allowOtherWorkspaceSession: true,
      });
    });
  });

  test("renders the navigation toolbar with the active session URL", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [createDiscoveredSession()],
      otherSessions: [],
    });
    mockSession = createSession({
      currentUrl: "https://current.example.com",
      pendingUrl: "https://pending.example.com",
      isPageLoading: true,
    });

    const view = render(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect((view.getByLabelText("Browser URL") as HTMLInputElement).value).toBe(
        "https://pending.example.com"
      );
    });

    expect((view.getByLabelText("Back") as HTMLButtonElement).disabled).toBe(false);
    expect((view.getByLabelText("Forward") as HTMLButtonElement).disabled).toBe(false);
    expect((view.getByLabelText("Reload") as HTMLButtonElement).disabled).toBe(false);
    expect(view.getByTestId("browser-toolbar-loading-icon")).toBeTruthy();
  });
});

describe("chooseExplicitOtherSession", () => {
  test("preserves an explicitly selected other session while it is still discovered", () => {
    expect(
      chooseExplicitOtherSession("other-alpha", [
        { sessionName: "other-alpha", status: "attachable", cwd: "/tmp/other-project" },
      ])
    ).toBe("other-alpha");
  });

  test("clears an explicitly selected other session when only a different other session exists", () => {
    expect(
      chooseExplicitOtherSession("other-alpha", [
        { sessionName: "other-beta", status: "attachable", cwd: "/tmp/other-project" },
      ])
    ).toBeNull();
  });

  test("clears an explicitly selected other session after discovery loses it", () => {
    expect(chooseExplicitOtherSession("other-alpha", [])).toBeNull();
  });
});

describe("shouldBackOffBrowserReconnect", () => {
  test("backs off retryable reconnects for the same session inside the retry window", () => {
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
  });

  test("stops backing off once the retry window elapses", () => {
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

  test('treats "is unavailable" bootstrap races as retryable', () => {
    expect(
      shouldBackOffBrowserReconnect({
        selectedSessionName: "alpha",
        session: createSession({
          sessionName: "alpha",
          status: "error",
          streamState: "error",
          lastError: "Browser session alpha is unavailable.",
        }),
        visibleError: "Browser session alpha is unavailable.",
        lastConnectAttempt: {
          sessionName: "alpha",
          attemptedAtMs: 10_000,
        },
        nowMs: 10_000 + BROWSER_PREVIEW_RETRY_INTERVAL_MS - 1,
      })
    ).toBe(true);
  });

  test("treats failed streaming enablement as retryable", () => {
    expect(
      shouldBackOffBrowserReconnect({
        selectedSessionName: "alpha",
        session: createSession({
          sessionName: "alpha",
          status: "error",
          streamState: "error",
          lastError: 'Failed to enable streaming for session "test"',
        }),
        visibleError: 'Failed to enable streaming for session "test"',
        lastConnectAttempt: {
          sessionName: "alpha",
          attemptedAtMs: 10_000,
        },
        nowMs: 10_000 + BROWSER_PREVIEW_RETRY_INTERVAL_MS - 1,
      })
    ).toBe(true);
  });

  test("treats failed streaming verification as retryable", () => {
    expect(
      shouldBackOffBrowserReconnect({
        selectedSessionName: "alpha",
        session: createSession({
          sessionName: "alpha",
          status: "error",
          streamState: "error",
          lastError:
            'Failed to verify streaming for session "test" after enabling (requested port 12345)',
        }),
        visibleError:
          'Failed to verify streaming for session "test" after enabling (requested port 12345)',
        lastConnectAttempt: {
          sessionName: "alpha",
          attemptedAtMs: 10_000,
        },
        nowMs: 10_000 + BROWSER_PREVIEW_RETRY_INTERVAL_MS - 1,
      })
    ).toBe(true);
  });

  test("does not treat missing sessions as retryable", () => {
    expect(
      shouldBackOffBrowserReconnect({
        selectedSessionName: "alpha",
        session: createSession({
          sessionName: "alpha",
          status: "error",
          streamState: "error",
          lastError: 'Session "test" not found for workspace "ws"',
        }),
        visibleError: 'Session "test" not found for workspace "ws"',
        lastConnectAttempt: {
          sessionName: "alpha",
          attemptedAtMs: 10_000,
        },
        nowMs: 10_000 + BROWSER_PREVIEW_RETRY_INTERVAL_MS - 1,
      })
    ).toBe(false);
  });

  test("does not back off different sessions or non-retryable failures", () => {
    expect(
      shouldBackOffBrowserReconnect({
        selectedSessionName: "beta",
        session: createSession({
          sessionName: "alpha",
          status: "error",
          streamState: "error",
          lastError: "fatal bootstrap failure",
        }),
        visibleError: "fatal bootstrap failure",
        lastConnectAttempt: {
          sessionName: "alpha",
          attemptedAtMs: 10_000,
        },
        nowMs: 10_000 + 1,
      })
    ).toBe(false);
  });
});
