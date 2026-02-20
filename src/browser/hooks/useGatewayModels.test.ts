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
let mockConfig: Record<string, Record<string, unknown>> = {};

const useProvidersConfigMock = mock(() => ({
  config: mockConfig,
  updateOptimistically: (provider: string, updates: Record<string, unknown>) => {
    optimisticUpdates.push({ provider, updates });
    // Apply optimistically to local mock (simulates what updateOptimistically does)
    mockConfig = {
      ...mockConfig,
      [provider]: { ...mockConfig[provider], ...updates },
    };
  },
}));

void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: useProvidersConfigMock,
}));

const updateMuxGatewayPrefsMock = mock(() => Promise.resolve({ success: true }));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      config: {
        updateMuxGatewayPrefs: updateMuxGatewayPrefsMock,
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
    optimisticUpdates = [];
    updateMuxGatewayPrefsMock.mockClear();
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

    // Optimistic update should add the model
    expect(optimisticUpdates).toHaveLength(1);
    expect(optimisticUpdates[0]).toEqual({
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

  test("drains pending enrollments from migrateGatewayModel after config loads", () => {
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
    // Queue should be drained
    expect(pendingGatewayEnrollments.size).toBe(0);
  });

  test("skips enrollment for already-enrolled models", () => {
    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: true,
        gatewayModels: ["anthropic:claude-opus-4-5"],
      },
    };

    // Queue model that's already enrolled
    pendingGatewayEnrollments.add("anthropic:claude-opus-4-5");

    renderHook(() => useGateway());

    // No optimistic update or IPC call — model already enrolled
    expect(optimisticUpdates).toHaveLength(0);
    expect(updateMuxGatewayPrefsMock).not.toHaveBeenCalled();
    // Queue should still be drained
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
  test("enrollment IPC failure doesn't crash and optimistic state is preserved", async () => {
    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: true,
        gatewayModels: [],
      },
    };

    // Make persist call fail
    updateMuxGatewayPrefsMock.mockImplementationOnce(() => Promise.reject(new Error("IPC failed")));

    pendingGatewayEnrollments.add("anthropic:claude-opus-4-5");

    const { result } = renderHook(() => useGateway());

    // Should have attempted persistence and applied optimistic update
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(1);
    const enrollUpdate = optimisticUpdates.find((u) => u.updates.gatewayModels != null);
    expect(enrollUpdate).toBeDefined();
    expect(enrollUpdate!.updates.gatewayModels).toEqual(["anthropic:claude-opus-4-5"]);

    // Let the rejection handler settle (shouldn't throw or break the hook)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Hook remains functional — optimistic state shows model as enrolled
    expect(result.current.modelUsesGateway("anthropic:claude-opus-4-5")).toBe(true);
    pendingGatewayEnrollments.clear();
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
