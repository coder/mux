import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import React from "react";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";

import { useRouting } from "./useRouting";

let providersConfig: ProvidersConfigMap | null = null;
let routePriority: string[] = ["direct"];
let routeOverrides: Record<string, string> = {};
let configGetConfig: () => Promise<{
  routePriority: string[];
  routeOverrides: Record<string, string>;
}>;

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
      updateRoutePreferences: () => Promise.resolve(undefined),
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
  beforeEach(() => {
    globalThis.window = new GlobalWindow({ url: "https://mux.example.com/" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    providersConfig = null;
    routePriority = ["direct"];
    routeOverrides = {};
    configGetConfig = () => Promise.resolve({ routePriority, routeOverrides });
  });

  afterEach(() => {
    cleanup();
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
});
