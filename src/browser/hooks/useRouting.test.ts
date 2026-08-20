import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import React from "react";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";

import { useRouting } from "./useRouting";

let providersConfig: ProvidersConfigMap | null = null;
let routePriority: string[] = ["direct"];
let routeOverrides: Record<string, string> = {};
let configGetConfig: () => Promise<{
  routePriority: string[];
  routeOverrides: Record<string, string>;
}>;
let updateRoutePreferencesImpl: () => Promise<undefined>;

async function* emptyStream() {
  await Promise.resolve();
  for (const item of [] as unknown[]) {
    yield item;
  }
}

function createStubApiClient(): APIClient {
  return {
    providers: {
      getConfig: () => Promise.resolve(providersConfig),
      onConfigChanged: () => Promise.resolve(emptyStream()),
    },
    config: {
      getConfig: () => configGetConfig(),
      onConfigChanged: () => Promise.resolve(emptyStream()),
      updateRoutePreferences: () => updateRoutePreferencesImpl(),
    },
  } as unknown as APIClient;
}

const stubClient = createStubApiClient();

const wrapper: React.FC<{ children: React.ReactNode }> = (props) =>
  React.createElement(
    APIProvider,
    { client: stubClient } as React.ComponentProps<typeof APIProvider>,
    props.children
  );

describe("useRouting", () => {
  let previousWindow: typeof globalThis.window;
  let previousDocument: typeof globalThis.document;
  let testWindow: GlobalWindow | null = null;

  beforeEach(() => {
    previousWindow = globalThis.window;
    previousDocument = globalThis.document;
    testWindow = new GlobalWindow({ url: "https://mux.example.com/" });
    globalThis.window = testWindow as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    providersConfig = null;
    routePriority = ["direct"];
    routeOverrides = {};
    configGetConfig = () => Promise.resolve({ routePriority, routeOverrides });
    updateRoutePreferencesImpl = () => Promise.resolve(undefined);
  });

  afterEach(() => {
    cleanup();
    getProvidersConfigStore().setClient(null);
    getAppConfigStore().setClient(null);
    testWindow?.close();
    testWindow = null;
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  });

  test("resolveRoute and availableRoutes honor gateway model accessibility", async () => {
    providersConfig = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      "github-copilot": {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [KNOWN_MODELS.GPT_54_MINI.providerModelId],
      },
    };

    // useProvidersConfig/useRouting read the shared stores (wired by
    // AppLoader in the real app); this hook test bypasses AppLoader, so wire
    // them manually AFTER the stubbed config is in place so the stores' fetch
    // observes it.
    getProvidersConfigStore().setClient(stubClient);
    getAppConfigStore().setClient(stubClient);

    const { result } = renderHook(() => useRouting(), { wrapper });

    await waitFor(() => {
      expect(
        result.current
          .availableRoutes(KNOWN_MODELS.GPT.id)
          .some((route) => route.route === "github-copilot")
      ).toBe(false);
    });

    expect(result.current.resolveRoute(KNOWN_MODELS.GPT.id)).toEqual({
      route: "direct",
      isAuto: true,
      displayName: "Direct",
    });
  });

  test("hook instances share one config fetch via the AppConfigStore", async () => {
    routeOverrides = { "openai:gpt-5.4": "mux-gateway" };
    let configFetchCount = 0;
    const baseGetConfig = configGetConfig;
    configGetConfig = () => {
      configFetchCount++;
      return baseGetConfig();
    };
    getProvidersConfigStore().setClient(stubClient);
    getAppConfigStore().setClient(stubClient);

    // Regression: each useRouting instance used to issue its own
    // config.getConfig fetch + onConfigChanged subscription, so surfaces with
    // one picker per row fanned out O(rows) backend reads.
    const first = renderHook(() => useRouting(), { wrapper });
    const second = renderHook(() => useRouting(), { wrapper });

    await waitFor(() => {
      expect(first.result.current.routeOverrides).toEqual(routeOverrides);
      expect(second.result.current.routeOverrides).toEqual(routeOverrides);
    });
    expect(configFetchCount).toBe(1);
  });

  test("failed route persistence refreshes the shared store from the backend", async () => {
    // The optimistic update lands in the SINGLETON store, so a failed write
    // must re-fetch: otherwise the stale route survives navigation and every
    // picker keeps gating on state the backend never accepted.
    updateRoutePreferencesImpl = () => Promise.reject(new Error("write failed"));
    getProvidersConfigStore().setClient(stubClient);
    getAppConfigStore().setClient(stubClient);

    const { result } = renderHook(() => useRouting(), { wrapper });
    await waitFor(() => expect(result.current.routePriority).toEqual(["direct"]));

    act(() => {
      result.current.setRoutePriority(["mux-gateway", "direct"]);
    });
    expect(result.current.routePriority).toEqual(["mux-gateway", "direct"]);

    await waitFor(() => expect(result.current.routePriority).toEqual(["direct"]));
  });
});
