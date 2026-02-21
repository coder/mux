/**
 * Tests for useGateway hook
 *
 * Key invariant: clicking a gateway toggle should flip the value exactly once,
 * calling updateOptimistically for instant UI feedback and IPC for persistence.
 * No localStorage dependency — all state comes from the provider config.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import {
  isGatewayFormat,
  isProviderSupported,
  migrateGatewayModel,
  pendingGatewayEnrollments,
  toGatewayModel,
  useGateway,
} from "./useGatewayModels";

// Tracks optimistic updates applied to provider config
let optimisticUpdates: Array<{ provider: string; updates: Record<string, unknown> }> = [];
let mockConfig: Record<string, Record<string, unknown>> | null = {};

const useProvidersConfigMock = mock(() => ({
  config: mockConfig,
  updateOptimistically: (provider: string, updates: Record<string, unknown>) => {
    optimisticUpdates.push({ provider, updates });
    // Apply optimistically to local mock (simulates what updateOptimistically does)
    const prevConfig = mockConfig ?? {};
    const prevProvider = prevConfig[provider] ?? {};
    mockConfig = {
      ...prevConfig,
      [provider]: { ...prevProvider, ...updates },
    };
  },
}));

void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: useProvidersConfigMock,
}));

const updateMuxGatewayPrefsMock = mock(() => Promise.resolve({ success: true }));
const getProvidersConfigMock = mock(() => Promise.resolve(mockConfig));
let apiAvailable = true;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: apiAvailable
      ? {
          config: {
            updateMuxGatewayPrefs: updateMuxGatewayPrefsMock,
          },
          providers: {
            getConfig: getProvidersConfigMock,
          },
        }
      : null,
    status: apiAvailable ? ("connected" as const) : ("disconnected" as const),
    error: null,
  }),
}));

describe("useGateway", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    optimisticUpdates = [];
    pendingGatewayEnrollments.clear();
    updateMuxGatewayPrefsMock.mockClear();
    getProvidersConfigMock.mockClear();
    apiAvailable = true;
    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: true,
        gatewayModels: [],
      },
    };
  });

  afterEach(() => {
    cleanup();
    pendingGatewayEnrollments.clear();
    apiAvailable = true;
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  const flushAsyncWork = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  test("toggleEnabled flips isEnabled once per call via optimistic update", async () => {
    const { result } = renderHook(() => useGateway());

    expect(result.current.isConfigured).toBe(true);
    expect(result.current.isEnabled).toBe(true);

    act(() => result.current.toggleEnabled());
    await flushAsyncWork();

    const enabledUpdates = optimisticUpdates.filter((u) => u.updates.isEnabled != null);
    expect(enabledUpdates.length).toBeGreaterThanOrEqual(1);
    expect(enabledUpdates[0]).toEqual({
      provider: "mux-gateway",
      updates: { isEnabled: false },
    });
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(1);
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledWith({
      muxGatewayEnabled: false,
      muxGatewayModels: [],
    });
  });

  test("toggleEnabled is optimistic even when API is unavailable", () => {
    apiAvailable = false;
    const { result } = renderHook(() => useGateway());

    act(() => result.current.toggleEnabled());

    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(0);
    const enabledUpdates = optimisticUpdates.filter((u) => u.updates.isEnabled != null);
    expect(enabledUpdates.at(-1)).toEqual({
      provider: "mux-gateway",
      updates: { isEnabled: false },
    });
  });

  test("setEnabledModels persists with the current enabled-state", async () => {
    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: false,
        gatewayModels: [],
      },
    };

    const { result } = renderHook(() => useGateway());

    act(() => {
      result.current.setEnabledModels(["anthropic:claude-opus-4-5"]);
    });
    await flushAsyncWork();

    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(1);
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledWith({
      muxGatewayEnabled: false,
      muxGatewayModels: ["anthropic:claude-opus-4-5"],
    });
  });

  test("toggleModelGateway flips model membership once per call", async () => {
    const { result } = renderHook(() => useGateway());

    const modelId = "openai:gpt-5.2";
    act(() => result.current.toggleModelGateway(modelId));
    await flushAsyncWork();

    const modelUpdates = optimisticUpdates.filter((u) => u.updates.gatewayModels != null);
    expect(modelUpdates.length).toBeGreaterThanOrEqual(1);
    expect(modelUpdates[0]).toEqual({
      provider: "mux-gateway",
      updates: { gatewayModels: [modelId] },
    });
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledWith({
      muxGatewayEnabled: true,
      muxGatewayModels: [modelId],
    });
  });

  test("derives state from provider config without localStorage", () => {
    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: false,
        gatewayModels: ["anthropic:claude-opus-4-5"],
      },
    };

    const { result } = renderHook(() => useGateway());

    expect(result.current.isConfigured).toBe(true);
    expect(result.current.isEnabled).toBe(false);
    expect(result.current.isActive).toBe(false);
    expect(result.current.modelUsesGateway("anthropic:claude-opus-4-5")).toBe(true);
    expect(result.current.modelUsesGateway("openai:gpt-4")).toBe(false);
  });

  test("treats missing mux-gateway config as unconfigured once hydrated", () => {
    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: true,
        gatewayModels: [],
      },
    };

    const { result, rerender } = renderHook(() => useGateway());
    expect(result.current.isConfigured).toBe(true);

    mockConfig = {
      anthropic: {
        apiKeySet: true,
        isEnabled: true,
      },
    };

    act(() => {
      rerender();
    });

    expect(result.current.isConfigured).toBe(false);
    expect(result.current.isActive).toBe(false);
  });

  test("marks gateway unconfigured when session-expired event fires", () => {
    renderHook(() => useGateway());

    act(() => {
      window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED));
    });

    const expiryUpdate = [...optimisticUpdates]
      .reverse()
      .find((u) => u.provider === "mux-gateway" && u.updates.couponCodeSet === false);
    expect(expiryUpdate).toEqual({
      provider: "mux-gateway",
      updates: { couponCodeSet: false },
    });
  });

  test("defers session-expired event until provider config hydrates", () => {
    mockConfig = null;

    const { rerender } = renderHook(() => useGateway());

    act(() => {
      window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED));
    });

    expect(optimisticUpdates).toHaveLength(0);

    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: true,
        gatewayModels: [],
      },
    };

    act(() => {
      rerender();
    });

    const expiryUpdate = optimisticUpdates.find(
      (u) => u.provider === "mux-gateway" && u.updates.couponCodeSet === false
    );
    expect(expiryUpdate).toEqual({
      provider: "mux-gateway",
      updates: { couponCodeSet: false },
    });
  });

  test("drains pending enrollments from migrateGatewayModel after config loads", async () => {
    pendingGatewayEnrollments.add("anthropic:claude-opus-4-5");

    renderHook(() => useGateway());
    await flushAsyncWork();

    const enrollUpdate = optimisticUpdates.find((u) => u.updates.gatewayModels != null);
    expect(enrollUpdate).toBeDefined();
    expect(enrollUpdate!.updates.gatewayModels).toEqual(["anthropic:claude-opus-4-5"]);
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledWith({
      muxGatewayEnabled: true,
      muxGatewayModels: ["anthropic:claude-opus-4-5"],
    });

    expect(pendingGatewayEnrollments.size).toBe(0);
  });

  test("flushes enrollments queued after hook mount", async () => {
    renderHook(() => useGateway());

    act(() => {
      expect(migrateGatewayModel("mux-gateway:openai/gpt-5.2")).toBe("openai:gpt-5.2");
    });
    await flushAsyncWork();

    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledWith({
      muxGatewayEnabled: true,
      muxGatewayModels: ["openai:gpt-5.2"],
    });
    expect(pendingGatewayEnrollments.size).toBe(0);
  });

  test("drops queued enrollments that are already persisted", async () => {
    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: true,
        gatewayModels: ["anthropic:claude-opus-4-5"],
      },
    };

    pendingGatewayEnrollments.add("anthropic:claude-opus-4-5");

    renderHook(() => useGateway());
    await flushAsyncWork();

    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(0);
    expect(pendingGatewayEnrollments.size).toBe(0);
  });

  test("keeps queued enrollments until provider config hydration completes", async () => {
    mockConfig = null;
    pendingGatewayEnrollments.add("anthropic:claude-opus-4-5");

    const { rerender } = renderHook(() => useGateway());
    await flushAsyncWork();

    // Hydration not finished yet: keep enrollment queued.
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(0);
    expect(pendingGatewayEnrollments.has("anthropic:claude-opus-4-5")).toBe(true);

    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: true,
        gatewayModels: [],
      },
    };

    act(() => {
      rerender();
    });
    await flushAsyncWork();

    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(1);
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledWith({
      muxGatewayEnabled: true,
      muxGatewayModels: ["anthropic:claude-opus-4-5"],
    });
    expect(pendingGatewayEnrollments.size).toBe(0);
  });

  test("drops queued enrollments when mux-gateway config is unavailable", async () => {
    mockConfig = {
      anthropic: {
        apiKeySet: true,
        isEnabled: true,
      },
    };

    pendingGatewayEnrollments.add("anthropic:claude-opus-4-5");

    renderHook(() => useGateway());
    await flushAsyncWork();

    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(0);
    expect(pendingGatewayEnrollments.size).toBe(0);
  });
});

describe("pure utility functions", () => {
  test("isGatewayFormat detects mux-gateway: prefix", () => {
    expect(isGatewayFormat("mux-gateway:anthropic/claude-opus-4-5")).toBe(true);
    expect(isGatewayFormat("anthropic:claude-opus-4-5")).toBe(false);
    expect(isGatewayFormat("")).toBe(false);
  });

  test("isProviderSupported checks against known gateway providers", () => {
    expect(isProviderSupported("anthropic:claude-opus-4-5")).toBe(true);
    expect(isProviderSupported("openai:gpt-4")).toBe(true);
    expect(isProviderSupported("unknown:model")).toBe(false);
    expect(isProviderSupported("no-colon")).toBe(false);
  });

  test("migrateGatewayModel converts mux-gateway: to canonical format", () => {
    expect(migrateGatewayModel("mux-gateway:anthropic/claude-opus-4-5")).toBe(
      "anthropic:claude-opus-4-5"
    );
    expect(migrateGatewayModel("anthropic:claude-opus-4-5")).toBe("anthropic:claude-opus-4-5");
    expect(migrateGatewayModel("mux-gateway:malformed")).toBe("mux-gateway:malformed");
  });

  test("toGatewayModel routes through gateway when all conditions met", () => {
    const config = {
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
        gatewayModels: ["anthropic:claude-opus-4-5"],
      },
    };

    expect(toGatewayModel("anthropic:claude-opus-4-5", config)).toBe(
      "mux-gateway:anthropic/claude-opus-4-5"
    );
  });

  test("toGatewayModel returns original when gateway disabled", () => {
    const config = {
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: false,
        isConfigured: true,
        couponCodeSet: true,
        gatewayModels: ["anthropic:claude-opus-4-5"],
      },
    };

    expect(toGatewayModel("anthropic:claude-opus-4-5", config)).toBe("anthropic:claude-opus-4-5");
  });

  test("toGatewayModel returns original when model not enrolled", () => {
    const config = {
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
        gatewayModels: [],
      },
    };

    expect(toGatewayModel("anthropic:claude-opus-4-5", config)).toBe("anthropic:claude-opus-4-5");
  });

  test("toGatewayModel returns original when not configured", () => {
    const config = {
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: false,
        gatewayModels: ["anthropic:claude-opus-4-5"],
      },
    };

    expect(toGatewayModel("anthropic:claude-opus-4-5", config)).toBe("anthropic:claude-opus-4-5");
  });
});
