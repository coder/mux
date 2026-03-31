import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalWindow } from "happy-dom";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { requireTestModule } from "@/browser/testUtils";
import type * as UseRoutingModule from "./useRouting";

let providersConfig: ProvidersConfigMap | null = null;
let routePriority: string[] = ["direct"];
let routeOverrides: Record<string, string> = {};

async function* emptyConfigStream() {
  await Promise.resolve();
  for (const item of [] as unknown[]) {
    yield item;
  }
}

const getConfigMock = mock(() =>
  Promise.resolve({
    routePriority,
    routeOverrides,
  })
);
const onConfigChangedMock = mock(() => Promise.resolve(emptyConfigStream()));
const updateRoutePreferencesMock = mock(() => Promise.resolve(undefined));

const useProvidersConfigMock = mock(() => ({
  config: providersConfig,
  refresh: () => Promise.resolve(),
}));

void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: useProvidersConfigMock,
}));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      config: {
        getConfig: getConfigMock,
        onConfigChanged: onConfigChangedMock,
        updateRoutePreferences: updateRoutePreferencesMock,
      },
    },
  }),
}));

const hooksDir = dirname(fileURLToPath(import.meta.url));

const { useRouting } = requireTestModule<{ useRouting: typeof UseRoutingModule.useRouting }>(
  join(hooksDir, "useRouting.ts")
);

describe("useRouting", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    providersConfig = null;
    routePriority = ["direct"];
    routeOverrides = {};
    getConfigMock.mockClear();
    onConfigChangedMock.mockClear();
    updateRoutePreferencesMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("resolveRoute and resolveAutoRoute honor gateway model accessibility", async () => {
    providersConfig = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      "github-copilot": {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [KNOWN_MODELS.GPT_54_MINI.providerModelId],
      },
    };
    routePriority = ["github-copilot", "direct"];

    const { result } = renderHook(() => useRouting());

    await waitFor(() => expect(result.current.routePriority).toEqual(["github-copilot", "direct"]));

    expect(result.current.resolveRoute(KNOWN_MODELS.GPT.id)).toEqual({
      route: "direct",
      isAuto: true,
      displayName: "Direct",
    });
    expect(result.current.resolveAutoRoute(KNOWN_MODELS.GPT.id)).toEqual({
      route: "direct",
      isAuto: true,
      displayName: "Direct",
    });
  });
});
