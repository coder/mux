import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import {
  filterHiddenModels,
  getDefaultModel,
  getSuggestedModels,
  useModelsFromSettings,
} from "./useModelsFromSettings";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { DEFAULT_MODEL_KEY, HIDDEN_MODELS_KEY } from "@/common/constants/storage";

function countOccurrences(haystack: string[], needle: string): number {
  return haystack.filter((v) => v === needle).length;
}

let providersConfig: ProvidersConfigMap | null = null;
let routePriority: string[] = ["direct"];
let routeOverrides: Record<string, string> = {};

const OPENROUTER_OPENAI_CUSTOM_MODEL = "openrouter:openai/gpt-5";

interface TestApi {
  config?: {
    updateModelPreferences?: (patch: {
      defaultModel?: string;
      hiddenModels?: string[];
    }) => Promise<unknown>;
  };
  providers?: {
    getConfig?: () => Promise<ProvidersConfigMap>;
    setModels?: (input: { provider: string; models: string[] }) => Promise<unknown>;
  };
}

let apiMock: TestApi | null = null;

const useProvidersConfigMock = mock(() => ({
  config: providersConfig,
  refresh: () => Promise.resolve(),
}));

const useRoutingMock = mock(() => ({
  routePriority,
  routeOverrides,
  resolveRoute: () => ({ route: "direct", isAuto: true, displayName: "Direct" }),
  availableRoutes: () => [],
  setRoutePreferences: () => {
    /* noop */
  },
  setRoutePriority: () => {
    /* noop */
  },
  setRouteOverride: () => {
    /* noop */
  },
}));

void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: useProvidersConfigMock,
}));

void mock.module("@/browser/hooks/useRouting", () => ({
  useRouting: useRoutingMock,
}));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: apiMock }),
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

describe("useModelsFromSettings selected model preservation", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.window.localStorage.clear();
    providersConfig = null;
    routePriority = ["direct"];
    routeOverrides = {};
    apiMock = null;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    apiMock = null;
  });

  test("getDefaultModel preserves explicit gateway-scoped defaults", () => {
    const gatewayModel = "openrouter:openai/gpt-5";
    globalThis.window.localStorage.setItem(DEFAULT_MODEL_KEY, JSON.stringify(gatewayModel));

    expect(getDefaultModel()).toBe(gatewayModel);
  });

  test("setDefaultModel persists explicit gateway-scoped defaults", async () => {
    const updateModelPreferences = mock(() => Promise.resolve(undefined));
    apiMock = {
      config: { updateModelPreferences },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    act(() => {
      result.current.setDefaultModel("openrouter:openai/gpt-5");
    });

    await waitFor(() => expect(result.current.defaultModel).toBe("openrouter:openai/gpt-5"));
    expect(globalThis.window.localStorage.getItem(DEFAULT_MODEL_KEY)).toBe(
      JSON.stringify("openrouter:openai/gpt-5")
    );
    expect(updateModelPreferences).toHaveBeenCalledWith({
      defaultModel: "openrouter:openai/gpt-5",
    });
  });

  test("ensureModelInSettings skips syncing explicit gateway-scoped selections", () => {
    const setModels = mock(() => Promise.resolve(undefined));
    providersConfig = {
      anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true, models: [] },
    };
    apiMock = {
      providers: {
        getConfig: () => Promise.resolve(providersConfig ?? {}),
        setModels,
      },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    act(() => {
      result.current.ensureModelInSettings("openrouter:anthropic/custom-model");
    });

    expect(setModels).not.toHaveBeenCalled();
  });

  test("ensureModelInSettings still syncs direct-provider custom models", async () => {
    const setModels = mock(() => Promise.resolve(undefined));
    providersConfig = {
      anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true, models: [] },
    };
    apiMock = {
      providers: {
        getConfig: () => Promise.resolve(providersConfig ?? {}),
        setModels,
      },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    act(() => {
      result.current.ensureModelInSettings("anthropic:custom-model");
    });

    await waitFor(() =>
      expect(setModels).toHaveBeenCalledWith({
        provider: "anthropic",
        models: ["custom-model"],
      })
    );
  });
});

describe("useModelsFromSettings OpenAI Codex OAuth gating", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.window.localStorage.clear();
    providersConfig = null;
    routePriority = ["direct"];
    routeOverrides = {};
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

    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.models).not.toContain("openai:gpt-5.2-codex");
    expect(result.current.models).toContain(KNOWN_MODELS.GPT_53_CODEX.id);
    expect(result.current.models).toContain("openai:gpt-5.3-codex-spark");
    expect(result.current.models).not.toContain("openai:gpt-5.2-pro");
  });

  test("api key only: hides Codex OAuth required OpenAI models", () => {
    providersConfig = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true, codexOauthSet: false },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.GPT_PRO.id);
    expect(result.current.models).not.toContain("openai:gpt-5.2-codex");
    expect(result.current.models).toContain(KNOWN_MODELS.GPT_53_CODEX.id);
    expect(result.current.models).not.toContain("openai:gpt-5.3-codex-spark");
  });

  test("api key + codex oauth: allows all OpenAI models", () => {
    providersConfig = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true, codexOauthSet: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.GPT_PRO.id);
    expect(result.current.models).not.toContain("openai:gpt-5.2-codex");
    expect(result.current.models).toContain(KNOWN_MODELS.GPT_53_CODEX.id);
    expect(result.current.models).toContain("openai:gpt-5.3-codex-spark");
  });

  test("neither with configured provider: hides Codex OAuth required OpenAI models", () => {
    providersConfig = {
      openai: { apiKeySet: false, isEnabled: true, isConfigured: true, codexOauthSet: false },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.GPT_PRO.id);
    expect(result.current.models).not.toContain("openai:gpt-5.2-codex");
    expect(result.current.models).toContain(KNOWN_MODELS.GPT_53_CODEX.id);
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
    routePriority = ["direct"];
    routeOverrides = {};
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

  test("keeps routed provider models visible when a gateway route is active", () => {
    providersConfig = {
      anthropic: { apiKeySet: false, isEnabled: true, isConfigured: false },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
      },
    };
    routePriority = ["mux-gateway", "direct"];
    routeOverrides = {};

    const { result } = renderHook(() => useModelsFromSettings());

    // Routing availability is provider-level: a configured mux-gateway makes
    // all built-in Anthropic models visible, not just a per-model allowlist.
    expect(result.current.models).toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.models).toContain(KNOWN_MODELS.SONNET.id);
    expect(result.current.models).toContain(KNOWN_MODELS.HAIKU.id);

    expect(result.current.hiddenModelsForSelector).not.toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.hiddenModelsForSelector).not.toContain(KNOWN_MODELS.SONNET.id);
    expect(result.current.hiddenModelsForSelector).not.toContain(KNOWN_MODELS.HAIKU.id);
  });

  test("excludes OAuth-gated OpenAI models from hidden bucket when unconfigured", () => {
    // OpenAI is unconfigured and neither API key nor OAuth is set.
    providersConfig = {
      openai: { apiKeySet: false, isEnabled: true, isConfigured: false, codexOauthSet: false },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    // OAuth-required models (currently Spark) should NOT appear in either list
    // because selecting them from "Show all models…" would fail at send time.
    expect(result.current.models).not.toContain("openai:gpt-5.3-codex-spark");
    expect(result.current.hiddenModelsForSelector).not.toContain("openai:gpt-5.3-codex-spark");

    // Non-OAuth-required OpenAI models should still be in the hidden bucket
    // when the provider is unconfigured.
    expect(result.current.hiddenModelsForSelector).toContain("openai:gpt-5.3-codex");
    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.GPT.id);
  });

  test("shows explicit OpenRouter custom models when only the direct provider is configured", () => {
    providersConfig = {
      openrouter: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: false,
        models: ["openai/gpt-5"],
      },
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
    expect(result.current.hiddenModelsForSelector).not.toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
  });

  test("shows explicit OpenRouter custom models once OpenRouter is configured", () => {
    providersConfig = {
      openrouter: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: ["openai/gpt-5"],
      },
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
    expect(result.current.hiddenModelsForSelector).not.toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
  });

  test("shows explicit OpenRouter custom models when OpenRouter is unavailable but mux-gateway is configured", () => {
    providersConfig = {
      openrouter: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: false,
        models: ["openai/gpt-5"],
      },
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      "mux-gateway": { apiKeySet: false, isEnabled: true, isConfigured: true },
    };
    routePriority = ["openrouter", "mux-gateway", "direct"];

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
    expect(result.current.hiddenModelsForSelector).not.toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
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

  test("gateway-prefixed custom model stays available via canonical route override when gateway is unavailable", () => {
    routePriority = ["direct"];
    routeOverrides = { "openai:gpt-5": "mux-gateway" };

    providersConfig = {
      openrouter: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: false,
        models: ["openai/gpt-5"],
      },
      openai: { apiKeySet: false, isEnabled: true, isConfigured: false },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
      },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
    expect(result.current.hiddenModelsForSelector).not.toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
  });

  test("provider missing from config is treated as unavailable without a route", () => {
    providersConfig = {
      anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.models).not.toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.GPT.id);
  });
});
