import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import {
  filterHiddenModels,
  getSuggestedModels,
  useModelsFromSettings,
} from "./useModelsFromSettings";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";

function countOccurrences(haystack: string[], needle: string): number {
  return haystack.filter((v) => v === needle).length;
}

let providersConfig: ProvidersConfigMap | null = null;

const useProvidersConfigMock = mock(() => ({
  config: providersConfig,
  refresh: () => Promise.resolve(),
}));

void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: useProvidersConfigMock,
}));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: null }),
}));

void mock.module("@/browser/contexts/PolicyContext", () => ({
  usePolicy: () => ({
    status: { state: "disabled" as const },
    policy: null,
  }),
}));

describe("getSuggestedModels", () => {
  test("returns custom models first, then built-ins (deduped)", () => {
    const firstBuiltIn = Object.values(KNOWN_MODELS)[0];
    if (!firstBuiltIn) {
      throw new Error("KNOWN_MODELS unexpectedly empty");
    }
    const builtIn = firstBuiltIn.id;
    const [builtInProvider, builtInModelId] = builtIn.split(":", 2);
    if (!builtInProvider || !builtInModelId) {
      throw new Error(`Unexpected built-in model id: ${builtIn}`);
    }

    const config: ProvidersConfigMap = {
      openai: { apiKeySet: true, isConfigured: true, models: ["my-team-model"] },
      [builtInProvider]: { apiKeySet: true, isConfigured: true, models: [builtInModelId] },
      "mux-gateway": {
        apiKeySet: true,
        isConfigured: true,
        couponCodeSet: true,
        models: ["ignored"],
      },
    };

    const suggested = getSuggestedModels(config);

    // Custom models are listed first (in config order)
    expect(suggested[0]).toBe("openai:my-team-model");
    expect(suggested[1]).toBe(`${builtInProvider}:${builtInModelId}`);

    // mux-gateway models should never appear as selectable entries
    expect(suggested.some((m) => m.startsWith("mux-gateway:"))).toBe(false);

    // Built-ins should be present, but deduped against any custom entry
    expect(countOccurrences(suggested, builtIn)).toBe(1);
  });
});

describe("filterHiddenModels", () => {
  test("filters out hidden models", () => {
    expect(filterHiddenModels(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
  });
});

describe("useModelsFromSettings OpenAI Codex OAuth gating", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.window.localStorage.clear();
    providersConfig = null;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("codex oauth only: hides API-key-only OpenAI models", () => {
    providersConfig = {
      openai: { apiKeySet: false, isConfigured: true, codexOauthSet: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain("openai:gpt-5.2");
    expect(result.current.models).toContain("openai:gpt-5.1-codex");
    expect(result.current.models).not.toContain("openai:gpt-5.2-pro");
  });

  test("api key only: hides Codex OAuth required OpenAI models", () => {
    providersConfig = {
      openai: { apiKeySet: true, isConfigured: true, codexOauthSet: false },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain("openai:gpt-5.2-pro");
    expect(result.current.models).not.toContain("openai:gpt-5.1-codex");
  });

  test("api key + codex oauth: allows all OpenAI models", () => {
    providersConfig = {
      openai: { apiKeySet: true, isConfigured: true, codexOauthSet: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain("openai:gpt-5.2-pro");
    expect(result.current.models).toContain("openai:gpt-5.1-codex");
  });

  test("neither: hides Codex OAuth required OpenAI models (status quo)", () => {
    providersConfig = {
      openai: { apiKeySet: false, isConfigured: false, codexOauthSet: false },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain("openai:gpt-5.2-pro");
    expect(result.current.models).not.toContain("openai:gpt-5.1-codex");
  });
});
