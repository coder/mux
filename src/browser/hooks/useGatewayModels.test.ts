/**
 * Tests for useGateway hook
 *
 * Key invariant: clicking a gateway toggle should flip the value exactly once,
 * calling updateOptimistically for instant UI feedback and IPC for persistence.
 * No localStorage dependency — all state comes from the provider config.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";

let isGatewayFormat!: typeof import("./useGatewayModels").isGatewayFormat;
let isProviderSupported!: typeof import("./useGatewayModels").isProviderSupported;
let migrateGatewayModel!: typeof import("./useGatewayModels").migrateGatewayModel;
let pendingGatewayEnrollments!: typeof import("./useGatewayModels").pendingGatewayEnrollments;
let toGatewayModel!: typeof import("./useGatewayModels").toGatewayModel;
let useGateway!: typeof import("./useGatewayModels").useGateway;

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

const updateMuxGatewayPrefsMock = mock(() => Promise.resolve({ success: true }));
let currentApiClient: Partial<APIClient> | null = null;

function createDisconnectedWebSocket(): WebSocket {
  const target = new EventTarget();

  return {
    url: "ws://localhost/orpc/ws",
    readyState: WebSocket.CLOSED,
    bufferedAmount: 0,
    extensions: "",
    protocol: "",
    binaryType: "arraybuffer",
    CONNECTING: WebSocket.CONNECTING,
    OPEN: WebSocket.OPEN,
    CLOSING: WebSocket.CLOSING,
    CLOSED: WebSocket.CLOSED,
    onopen: null,
    onerror: null,
    onclose: null,
    onmessage: null,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    close: () => undefined,
    send: () => undefined,
  } as unknown as WebSocket;
}

function renderUseGatewayHook() {
  return renderHook(() => useGateway(), {
    wrapper: (props: { children: ReactNode }) =>
      createElement(
        APIProvider,
        currentApiClient
          ? { client: currentApiClient as APIClient }
          : { createWebSocket: createDisconnectedWebSocket },
        props.children
      ),
  });
}

describe("useGateway", () => {
  beforeEach(async () => {
    void mock.module("@/browser/hooks/useProvidersConfig", () => ({
      useProvidersConfig: useProvidersConfigMock,
    }));

    ({
      isGatewayFormat,
      isProviderSupported,
      migrateGatewayModel,
      pendingGatewayEnrollments,
      toGatewayModel,
      useGateway,
    } = await import("./useGatewayModels"));
    mock.restore();

    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    optimisticUpdates = [];
    pendingGatewayEnrollments.clear();
    updateMuxGatewayPrefsMock.mockClear();
    currentApiClient = {
      config: {
        updateMuxGatewayPrefs: updateMuxGatewayPrefsMock,
      },
    };
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
    mock.restore();
    pendingGatewayEnrollments.clear();
    currentApiClient = null;
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
    const { result } = renderUseGatewayHook();

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
    currentApiClient = null;
    const { result } = renderUseGatewayHook();

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

    const { result } = renderUseGatewayHook();

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
    const { result } = renderUseGatewayHook();

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

    const { result } = renderUseGatewayHook();

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

    const { result, rerender } = renderUseGatewayHook();
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
    renderUseGatewayHook();

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

    const { rerender } = renderUseGatewayHook();

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

    renderUseGatewayHook();
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
    renderUseGatewayHook();

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

    renderUseGatewayHook();
    await flushAsyncWork();

    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(0);
    expect(pendingGatewayEnrollments.size).toBe(0);
  });

  test("keeps queued enrollments until provider config hydration completes", async () => {
    mockConfig = null;
    pendingGatewayEnrollments.add("anthropic:claude-opus-4-5");

    const { rerender } = renderUseGatewayHook();
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

    renderUseGatewayHook();
    await flushAsyncWork();

    expect(updateMuxGatewayPrefsMock).toHaveBeenCalledTimes(0);
    expect(pendingGatewayEnrollments.size).toBe(0);
  });
});

describe("pure utility functions", () => {
  beforeEach(async () => {
    ({
      isGatewayFormat,
      isProviderSupported,
      migrateGatewayModel,
      pendingGatewayEnrollments,
      toGatewayModel,
      useGateway,
    } = await import("./useGatewayModels"));
  });
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
