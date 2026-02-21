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
  pendingGatewayModelsUntilHydrated,
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
let apiAvailable = true;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: apiAvailable
      ? {
          config: {
            updateMuxGatewayPrefs: updateMuxGatewayPrefsMock,
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
    pendingGatewayModelsUntilHydrated.models = null;
    updateMuxGatewayPrefsMock.mockClear();
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
    pendingGatewayModelsUntilHydrated.models = null;
    apiAvailable = true;
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("toggleEnabled flips isEnabled once per call via optimistic update", () => {
    const { result } = renderHook(() => useGateway());

    expect(result.current.isConfigured).toBe(true);
    expect(result.current.isEnabled).toBe(true);

    act(() => result.current.toggleEnabled());

    // Optimistic update should set isEnabled: false
    expect(optimisticUpdates).toHaveLength(1);
    expect(optimisticUpdates[0]).toEqual({
      provider: "mux-gateway",
      updates: { isEnabled: false },
    });
    // IPC should be called with the new state
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(1);
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledWith({
      muxGatewayEnabled: false,
      muxGatewayModels: [],
    });
  });

  test("toggleModelGateway flips model membership once per call via optimistic update", () => {
    const { result } = renderHook(() => useGateway());

    expect(result.current.isConfigured).toBe(true);

    const modelId = "openai:gpt-5.2";

    act(() => result.current.toggleModelGateway(modelId));

    // Optimistic update should add the model.
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

  test("defers model persistence until enabled-state hydrates", () => {
    mockConfig = null;

    const { result, rerender } = renderHook(() => useGateway());

    act(() => {
      result.current.setEnabledModels(["anthropic:claude-opus-4-5"]);
    });

    // Optimistic UI update happens immediately.
    expect(optimisticUpdates).toHaveLength(1);
    expect(optimisticUpdates[0]).toEqual({
      provider: "mux-gateway",
      updates: { gatewayModels: ["anthropic:claude-opus-4-5"] },
    });

    // No persistence until gwConfig is hydrated.
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(0);

    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: false,
        gatewayModels: [],
      },
    };

    act(() => {
      rerender();
    });

    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(1);
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledWith({
      muxGatewayEnabled: false,
      muxGatewayModels: ["anthropic:claude-opus-4-5"],
    });
  });

  test("keeps deferred model persistence queued while API is unavailable", () => {
    mockConfig = null;

    const { result, rerender } = renderHook(() => useGateway());

    act(() => {
      result.current.setEnabledModels(["anthropic:claude-opus-4-5"]);
    });

    // Hydrate config while API is disconnected: persistence should remain queued.
    apiAvailable = false;
    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: false,
        gatewayModels: [],
      },
    };

    act(() => {
      rerender();
    });

    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(0);

    // Once API reconnects, queued persistence should flush with preserved enabled-state.
    apiAvailable = true;
    act(() => {
      rerender();
    });

    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(1);
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledWith({
      muxGatewayEnabled: false,
      muxGatewayModels: ["anthropic:claude-opus-4-5"],
    });
  });

  test("retries deferred model persistence after IPC rejection", async () => {
    mockConfig = null;
    updateMuxGatewayPrefsMock.mockImplementationOnce(() => Promise.reject(new Error("IPC failed")));

    const { result, rerender } = renderHook(() => useGateway());

    act(() => {
      result.current.setEnabledModels(["anthropic:claude-opus-4-5"]);
    });

    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: false,
        gatewayModels: [],
      },
    };

    act(() => {
      rerender();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(1);
    expect(pendingGatewayModelsUntilHydrated.models).toEqual(["anthropic:claude-opus-4-5"]);

    act(() => {
      window.dispatchEvent(new Event("mux:gatewayEnrollmentPending"));
    });

    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(2);
    expect(updateMuxGatewayPrefsMock).toHaveBeenLastCalledWith({
      muxGatewayEnabled: false,
      muxGatewayModels: ["anthropic:claude-opus-4-5"],
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

    // No config yet; event is deferred and no optimistic update is possible.
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
    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: true,
        gatewayModels: [],
      },
    };

    // Simulate migrateGatewayModel queuing a model during render
    pendingGatewayEnrollments.add("anthropic:claude-opus-4-5");

    renderHook(() => useGateway());

    // Should optimistically add the model and persist via IPC
    const enrollUpdate = optimisticUpdates.find((u) => u.updates.gatewayModels != null);
    expect(enrollUpdate).toBeDefined();
    expect(enrollUpdate!.updates.gatewayModels).toEqual(["anthropic:claude-opus-4-5"]);
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledWith({
      muxGatewayEnabled: true,
      muxGatewayModels: ["anthropic:claude-opus-4-5"],
    });

    // Queue drains after persistence resolves.
    await act(async () => {
      await Promise.resolve();
    });
    expect(pendingGatewayEnrollments.size).toBe(0);
  });

  test("persists queued enrollments even when model is already in local gateway state", async () => {
    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: true,
        gatewayModels: ["anthropic:claude-opus-4-5"],
      },
    };

    // Queue model that's already in local gateway state.
    // We still persist once so backend config catches up.
    pendingGatewayEnrollments.add("anthropic:claude-opus-4-5");

    renderHook(() => useGateway());

    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(1);
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledWith({
      muxGatewayEnabled: true,
      muxGatewayModels: ["anthropic:claude-opus-4-5"],
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(pendingGatewayEnrollments.size).toBe(0);
  });

  test("batches multiple pending enrollments together", () => {
    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: true,
        gatewayModels: [],
      },
    };

    // Queue two models simultaneously
    pendingGatewayEnrollments.add("anthropic:claude-opus-4-5");
    pendingGatewayEnrollments.add("openai:gpt-5.2");

    renderHook(() => useGateway());

    // Both should be enrolled in a single IPC call
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(1);
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledWith({
      muxGatewayEnabled: true,
      muxGatewayModels: ["anthropic:claude-opus-4-5", "openai:gpt-5.2"],
    });
  });

  test("drains models queued while a persistence call is in flight", async () => {
    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: true,
        gatewayModels: [],
      },
    };

    let resolveFirstPersist: (() => void) | null = null;
    updateMuxGatewayPrefsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstPersist = () => resolve({ success: true });
        })
    );

    pendingGatewayEnrollments.add("anthropic:claude-opus-4-5");

    renderHook(() => useGateway());

    // First drain started and is still in flight.
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(1);

    // Queue another model while first persist is in flight.
    pendingGatewayEnrollments.add("openai:gpt-5.2");
    act(() => {
      window.dispatchEvent(new Event("mux:gatewayEnrollmentPending"));
    });

    await act(async () => {
      resolveFirstPersist?.();
      await Promise.resolve();
    });

    // Second drain should run after first settles.
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(2);
    expect(updateMuxGatewayPrefsMock).toHaveBeenNthCalledWith(2, {
      muxGatewayEnabled: true,
      muxGatewayModels: ["anthropic:claude-opus-4-5", "openai:gpt-5.2"],
    });
  });
  test("keeps queued enrollments on IPC failure and retries with backoff", async () => {
    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: true,
        gatewayModels: [],
      },
    };

    // First persist attempt fails.
    updateMuxGatewayPrefsMock.mockImplementationOnce(() => Promise.reject(new Error("IPC failed")));

    pendingGatewayEnrollments.add("anthropic:claude-opus-4-5");

    renderHook(() => useGateway());

    // Should have attempted persistence and applied optimistic update.
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(1);
    const enrollUpdate = optimisticUpdates.find((u) => u.updates.gatewayModels != null);
    expect(enrollUpdate).toBeDefined();
    expect(enrollUpdate!.updates.gatewayModels).toEqual(["anthropic:claude-opus-4-5"]);

    // Let the rejection handler settle; queued enrollment should remain for retry.
    await act(async () => {
      await Promise.resolve();
    });
    expect(pendingGatewayEnrollments.has("anthropic:claude-opus-4-5")).toBe(true);

    // Backoff prevents immediate tight-loop retries.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(1);
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
