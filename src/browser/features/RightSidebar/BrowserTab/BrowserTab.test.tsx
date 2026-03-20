import { describe, expect, test } from "bun:test";
import { BROWSER_PREVIEW_RETRY_INTERVAL_MS, shouldBackOffBrowserReconnect } from "./BrowserTab";
import type { BrowserSession } from "./browserBridgeTypes";

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
