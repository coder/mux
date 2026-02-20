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
  toGatewayModel,
  useGateway,
} from "./useGatewayModels";
import { CUSTOM_EVENTS } from "@/common/constants/events";

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

  test("enrollment event from migrateGatewayModel persists gateway opt-in", () => {
    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: true,
        gatewayModels: [],
      },
    };

    renderHook(() => useGateway());

    // Dispatch the enrollment event (simulates migrateGatewayModel detecting a legacy model)
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CUSTOM_EVENTS.MUX_GATEWAY_ENROLL_MODEL, {
          detail: { modelId: "anthropic:claude-opus-4-5" },
        })
      );
    });

    // Should optimistically add the model and persist via IPC
    const enrollUpdate = optimisticUpdates.find((u) => u.updates.gatewayModels != null);
    expect(enrollUpdate).toBeDefined();
    expect(enrollUpdate!.updates.gatewayModels).toEqual(["anthropic:claude-opus-4-5"]);
    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledWith({
      muxGatewayEnabled: true,
      muxGatewayModels: ["anthropic:claude-opus-4-5"],
    });
  });

  test("enrollment event is no-op when model is already enrolled", () => {
    mockConfig = {
      "mux-gateway": {
        couponCodeSet: true,
        isEnabled: true,
        gatewayModels: ["anthropic:claude-opus-4-5"],
      },
    };

    renderHook(() => useGateway());

    act(() => {
      window.dispatchEvent(
        new CustomEvent(CUSTOM_EVENTS.MUX_GATEWAY_ENROLL_MODEL, {
          detail: { modelId: "anthropic:claude-opus-4-5" },
        })
      );
    });

    // No optimistic update or IPC call — model already enrolled
    expect(optimisticUpdates).toHaveLength(0);
    expect(updateMuxGatewayPrefsMock).not.toHaveBeenCalled();
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
