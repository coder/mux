import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { APIClient } from "@/browser/contexts/API";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

// Control what ping() returns across tests.
let mockPing: (input: string) => Promise<string> = () => Promise.resolve("pong");

void mock.module("@/common/orpc/client", () => ({
  createClient: () => ({
    general: {
      ping: (input: string) => mockPing(input),
    },
  }),
}));

void mock.module("@orpc/client/fetch", () => ({
  RPCLink: class {},
}));

void mock.module("@orpc/client/message-port", () => ({
  RPCLink: class {},
}));

void mock.module("@/browser/components/AuthTokenModal", () => ({
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

describe("API connection (fetch transport)", () => {
  beforeEach(() => {
    // Minimal DOM setup required by @testing-library/react.
    //
    // Happy DOM can default to an opaque origin ("null") in some modes (e.g. coverage).
    // That breaks URL construction in createBrowserClient(). Give it a stable http(s) origin.
    const happyWindow = new GlobalWindow({ url: "https://mux.example.com/" });
    globalThis.window = happyWindow as unknown as Window & typeof globalThis;
    globalThis.document = happyWindow.document as unknown as Document;

    // Default: ping succeeds.
    mockPing = () => Promise.resolve("pong");
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("transitions to connected when ping succeeds", async () => {
    const states: string[] = [];

    render(
      <APIProvider>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    await waitFor(() => {
      expect(states).toContain("connected");
    });
  });

  test("shows auth_required when ping returns an auth error", async () => {
    mockPing = () => Promise.reject(new Error("401 Unauthorized"));

    const states: string[] = [];

    render(
      <APIProvider>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    await waitFor(() => {
      expect(states).toContain("auth_required");
    });
  });

  test("retries on first connection failure without showing auth_required", async () => {
    // First call fails with a network error, subsequent calls succeed.
    let callCount = 0;
    mockPing = () => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("Failed to fetch"));
      }
      return Promise.resolve("pong");
    };

    const states: string[] = [];

    render(
      <APIProvider>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    // Should retry via reconnection, not show auth_required.
    await waitFor(() => {
      expect(states).toContain("reconnecting");
    });

    expect(states.filter((s) => s === "auth_required")).toHaveLength(0);

    // Eventually connects on retry.
    await waitFor(() => {
      expect(states).toContain("connected");
    });
  });

  test("uses pre-created client and skips connection flow", async () => {
    const mockClient = {
      general: { ping: () => Promise.resolve("pong") },
    } as unknown as APIClient;

    const states: string[] = [];

    render(
      <APIProvider client={mockClient}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    // Should immediately be connected without going through connecting.
    await waitFor(() => {
      expect(states[0]).toBe("connected");
    });
  });

  test("authenticate() triggers reconnection with new token", async () => {
    mockPing = () => Promise.reject(new Error("401 Unauthorized"));

    const capturedStates: UseAPIResult[] = [];

    render(
      <APIProvider>
        <APIStateObserver onState={(s) => capturedStates.push(s)} />
      </APIProvider>
    );

    // Wait for auth_required state.
    await waitFor(() => {
      expect(capturedStates.some((s) => s.status === "auth_required")).toBe(true);
    });

    // Now make ping succeed and call authenticate.
    mockPing = () => Promise.resolve("pong");

    await act(async () => {
      const lastState = capturedStates[capturedStates.length - 1];
      expect(lastState.status).toBe("auth_required");
      lastState.authenticate("new-token");
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(capturedStates.some((s) => s.status === "connected")).toBe(true);
    });
  });
});
