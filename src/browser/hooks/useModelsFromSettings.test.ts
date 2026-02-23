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
import { HIDDEN_MODELS_KEY } from "@/common/constants/storage";

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
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true, models: ["my-team-model"] },
      [builtInProvider]: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [builtInModelId],
      },
      "mux-gateway": {
        apiKeySet: true,
        isEnabled: true,
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

  test("skips custom models from disabled providers", () => {
    const config: ProvidersConfigMap = {
      openai: {
        apiKeySet: true,
        isEnabled: false,
        isConfigured: false,
        models: ["disabled-custom"],
      },
      anthropic: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: ["enabled-custom"],
      },
    };

    const suggested = getSuggestedModels(config);

    expect(suggested).toContain("anthropic:enabled-custom");
    expect(suggested).not.toContain("openai:disabled-custom");
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
      openai: { apiKeySet: false, isEnabled: true, isConfigured: true, codexOauthSet: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain("openai:gpt-5.2");
    expect(result.current.models).toContain("openai:gpt-5.2-codex");
    expect(result.current.models).toContain("openai:gpt-5.3-codex");
    expect(result.current.models).toContain("openai:gpt-5.3-codex-spark");
    expect(result.current.models).not.toContain("openai:gpt-5.2-pro");
  });

  test("api key only: hides Codex OAuth required OpenAI models", () => {
    providersConfig = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true, codexOauthSet: false },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain("openai:gpt-5.2-pro");
    expect(result.current.models).toContain("openai:gpt-5.2-codex");
    expect(result.current.models).not.toContain("openai:gpt-5.3-codex");
    expect(result.current.models).not.toContain("openai:gpt-5.3-codex-spark");
  });

  test("api key + codex oauth: allows all OpenAI models", () => {
    providersConfig = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true, codexOauthSet: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain("openai:gpt-5.2-pro");
    expect(result.current.models).toContain("openai:gpt-5.2-codex");
    expect(result.current.models).toContain("openai:gpt-5.3-codex");
    expect(result.current.models).toContain("openai:gpt-5.3-codex-spark");
  });

  test("neither with configured provider: hides Codex OAuth required OpenAI models", () => {
    providersConfig = {
      openai: { apiKeySet: false, isEnabled: true, isConfigured: true, codexOauthSet: false },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain("openai:gpt-5.2-pro");
    expect(result.current.models).toContain("openai:gpt-5.2-codex");
    expect(result.current.models).not.toContain("openai:gpt-5.3-codex");
    expect(result.current.models).not.toContain("openai:gpt-5.3-codex-spark");
  });

  test("exposes OpenAI auth state flags", () => {
    providersConfig = {
      openai: { apiKeySet: false, isEnabled: true, isConfigured: true, codexOauthSet: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.openaiApiKeySet).toBe(false);
    expect(result.current.codexOauthSet).toBe(true);
  });

  test("returns false OpenAI auth state flags when openai provider is missing", () => {
    providersConfig = {};

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.openaiApiKeySet).toBe(false);
    expect(result.current.codexOauthSet).toBe(false);
  });

  test("returns null OpenAI auth state flags when provider config is unknown", () => {
    providersConfig = null;

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.openaiApiKeySet).toBeNull();
    expect(result.current.codexOauthSet).toBeNull();
  });
});

describe("useModelsFromSettings provider availability gating", () => {
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

  test("hides models from unconfigured providers", () => {
    providersConfig = {
      anthropic: { apiKeySet: false, isEnabled: true, isConfigured: false },
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).not.toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.models).not.toContain(KNOWN_MODELS.SONNET.id);
    expect(result.current.models).not.toContain(KNOWN_MODELS.HAIKU.id);

    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.SONNET.id);

    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
  });

  test("keeps gateway-opted-in models visible when gateway is active", () => {
    providersConfig = {
      anthropic: { apiKeySet: false, isEnabled: true, isConfigured: false },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
        // Only OPUS is opted-in to gateway routing (via backend config, not localStorage)
        gatewayModels: [KNOWN_MODELS.OPUS.id],
      },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    // OPUS is opted-in to gateway — should stay visible
    expect(result.current.models).toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.hiddenModelsForSelector).not.toContain(KNOWN_MODELS.OPUS.id);

    // SONNET and HAIKU are NOT opted-in — should be hidden despite gateway being active
    expect(result.current.models).not.toContain(KNOWN_MODELS.SONNET.id);
    expect(result.current.models).not.toContain(KNOWN_MODELS.HAIKU.id);
    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.SONNET.id);
    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.HAIKU.id);
  });

  test("excludes OAuth-gated OpenAI models from hidden bucket when unconfigured", () => {
    // OpenAI is unconfigured and neither API key nor OAuth is set.
    providersConfig = {
      openai: { apiKeySet: false, isEnabled: true, isConfigured: false, codexOauthSet: false },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    // OAuth-required models (e.g. gpt-5.3-codex, gpt-5.3-codex-spark) should NOT appear in either list
    // because selecting them from "Show all models…" would also fail at send time.
    expect(result.current.models).not.toContain("openai:gpt-5.3-codex");
    expect(result.current.models).not.toContain("openai:gpt-5.3-codex-spark");
    expect(result.current.hiddenModelsForSelector).not.toContain("openai:gpt-5.3-codex");
    expect(result.current.hiddenModelsForSelector).not.toContain("openai:gpt-5.3-codex-spark");

    // Non-OAuth-required OpenAI models should still be in the hidden bucket
    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.GPT.id);
  });

  test("hides models from disabled providers", () => {
    providersConfig = {
      anthropic: { apiKeySet: true, isEnabled: false, isConfigured: true },
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).not.toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
  });

  test("keeps persisted hiddenModels separate from provider-hidden models", () => {
    globalThis.window.localStorage.setItem(
      HIDDEN_MODELS_KEY,
      JSON.stringify([KNOWN_MODELS.GPT.id])
    );

    providersConfig = {
      anthropic: { apiKeySet: false, isEnabled: true, isConfigured: false },
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.hiddenModels).toEqual([KNOWN_MODELS.GPT.id]);
    expect(result.current.hiddenModels).not.toContain(KNOWN_MODELS.OPUS.id);

    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.OPUS.id);
  });

  test("shows all built-in provider models when config is null", () => {
    providersConfig = null;

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.hiddenModelsForSelector.length).toBe(0);
  });

  test("provider missing from config is treated as available", () => {
    providersConfig = {
      anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
  });
});
