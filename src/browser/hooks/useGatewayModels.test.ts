/**
 * Tests for useGateway hook
 *
 * Key invariant: clicking a gateway toggle should flip the persisted value exactly once.
 *
 * Regression being tested:
 * - The hook previously double-wrote to localStorage (usePersistedState + updatePersistedState),
 *   causing the value to toggle twice and effectively become a no-op.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { useGateway } from "./useGatewayModels";

const useProvidersConfigMock = mock(() => ({
  config: {
    "mux-gateway": {
      couponCodeSet: true,
    },
  },
}));

void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: useProvidersConfigMock,
}));

// Mock useAPI - the hook uses api.config.updateMuxGatewayPrefs for persistence
// but has a defensive guard so it's safe to pass null/undefined.
void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      config: {
        updateMuxGatewayPrefs: () => Promise.resolve({ success: true }),
      },
    },
    status: "connected" as const,
    error: null,
  }),
}));

describe("useGateway", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("toggleEnabled flips gateway-enabled once per call", async () => {
    const { result } = renderHook(() => useGateway());

    await waitFor(() => expect(result.current.isConfigured).toBe(true));
    expect(result.current.isEnabled).toBe(true);

    act(() => result.current.toggleEnabled());

    expect(result.current.isEnabled).toBe(false);
    expect(globalThis.window.localStorage.getItem("gateway-enabled")).toBe("false");

    act(() => result.current.toggleEnabled());

    expect(result.current.isEnabled).toBe(true);
    expect(globalThis.window.localStorage.getItem("gateway-enabled")).toBe("true");
  });

  test("toggleModelGateway flips gateway-models membership once per call", async () => {
    const { result } = renderHook(() => useGateway());

    await waitFor(() => expect(result.current.isConfigured).toBe(true));

    const modelId = "openai:gpt-5.2";

    act(() => result.current.toggleModelGateway(modelId));

    expect(result.current.modelUsesGateway(modelId)).toBe(true);
    expect(JSON.parse(globalThis.window.localStorage.getItem("gateway-models") ?? "[]")).toContain(
      modelId
    );

    act(() => result.current.toggleModelGateway(modelId));

    expect(result.current.modelUsesGateway(modelId)).toBe(false);
    expect(
      JSON.parse(globalThis.window.localStorage.getItem("gateway-models") ?? "[]")
    ).not.toContain(modelId);
  });
});
