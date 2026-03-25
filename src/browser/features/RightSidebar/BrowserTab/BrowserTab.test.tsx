import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { useState } from "react";

import type { BrowserDiscoveredSession, BrowserSession } from "./browserBridgeTypes";

const listSessionsMock = mock(() =>
  Promise.resolve({ sessions: [] as BrowserDiscoveredSession[] })
);
const connectMock = mock(() => undefined);
const disconnectMock = mock(() => undefined);
const sendInputMock = mock(() => undefined);
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
  }),
}));

import {
  BROWSER_PREVIEW_RETRY_INTERVAL_MS,
  BrowserTab,
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
    listSessionsMock.mockResolvedValue({ sessions: [] });
    connectMock.mockReset();
    disconnectMock.mockReset();
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
