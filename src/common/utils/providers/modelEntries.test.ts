import { describe, expect, test } from "bun:test";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import {
  getModelContextWindowOverride,
  getProviderModelEntryMappedTo,
  normalizeProviderModelEntry,
  resolveModelForMetadata,
} from "./modelEntries";

describe("resolveModelForMetadata", () => {
  test("returns original model when no config", () => {
    expect(resolveModelForMetadata("ollama:custom", null)).toBe("ollama:custom");
  });

  test("returns original model when not mapped", () => {
    const config: ProvidersConfigMap = {
      ollama: { apiKeySet: false, isEnabled: true, isConfigured: true, models: ["custom"] },
    };

    expect(resolveModelForMetadata("ollama:custom", config)).toBe("ollama:custom");
  });

  test("returns mapped model when mapping exists", () => {
    const config: ProvidersConfigMap = {
      ollama: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "custom", mappedToModel: "anthropic:claude-sonnet-4-6" }],
      },
    };

    expect(resolveModelForMetadata("ollama:custom", config)).toBe("anthropic:claude-sonnet-4-6");
  });

  test("returns original model when model not in provider", () => {
    const config: ProvidersConfigMap = {
      ollama: { apiKeySet: false, isEnabled: true, isConfigured: true, models: ["other"] },
    };

    expect(resolveModelForMetadata("ollama:custom", config)).toBe("ollama:custom");
  });

  test("returns original model for unparseable ID", () => {
    expect(resolveModelForMetadata("bare-model", null)).toBe("bare-model");
  });
});

describe("resolveModelForMetadata for Coder gateway-scoped models", () => {
  // Gateway-scoped strings carry no catalog identity: pricing/context/cache
  // lookups must target the instance's upstream, derived from its type.
  const coderConfig: ProvidersConfigMap = {
    coder: {
      apiKeySet: false,
      isEnabled: true,
      isConfigured: true,
      discoveredProviders: [
        { name: "prod-anthropic", type: "anthropic" },
        { name: "google", type: "google" },
        { name: "llm-proxy", type: "openai-compat" },
      ],
    },
  };

  test("custom-named anthropic instance resolves to the anthropic catalog", () => {
    expect(resolveModelForMetadata("coder:prod-anthropic/claude-sonnet-4-5", coderConfig)).toBe(
      "anthropic:claude-sonnet-4-5"
    );
  });

  test("default-named instance of another direct provider resolves to its catalog", () => {
    expect(resolveModelForMetadata("coder:google/gemini-3-pro", coderConfig)).toBe(
      "google:gemini-3-pro"
    );
  });

  test("openai-compat instances stay gateway-scoped (unknowable upstream)", () => {
    expect(resolveModelForMetadata("coder:llm-proxy/some-model", coderConfig)).toBe(
      "coder:llm-proxy/some-model"
    );
  });

  test("explicit mappedToModel override wins over type derivation", () => {
    const config: ProvidersConfigMap = {
      coder: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        discoveredProviders: [{ name: "prod-anthropic", type: "anthropic" }],
        models: [{ id: "prod-anthropic/tuned-claude", mappedToModel: "anthropic:claude-opus-4-5" }],
      },
    };
    expect(resolveModelForMetadata("coder:prod-anthropic/tuned-claude", config)).toBe(
      "anthropic:claude-opus-4-5"
    );
  });

  test("custom OpenAI-compatible provider named coder keeps its own identity", () => {
    const config: ProvidersConfigMap = {
      coder: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        providerType: "openai-compatible",
        baseUrl: "https://proxy.example.com/v1",
      },
    };
    expect(resolveModelForMetadata("coder:anthropic/claude-opus-4-5", config)).toBe(
      "coder:anthropic/claude-opus-4-5"
    );
  });
});

describe("gateway-scoped provider model entry lookup", () => {
  test("getModelContextWindowOverride honors gateway-scoped contextWindowTokens", () => {
    const config: ProvidersConfigMap = {
      openrouter: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "anthropic/claude-sonnet-4-6", contextWindowTokens: 50000 }],
      },
    };

    expect(getModelContextWindowOverride("openrouter:anthropic/claude-sonnet-4-6", config)).toBe(
      50000
    );
  });

  test("resolveModelForMetadata honors gateway-scoped mappedToModel", () => {
    const config: ProvidersConfigMap = {
      openrouter: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "anthropic/claude-sonnet-4-6", mappedToModel: "custom:mapped-model" }],
      },
    };

    expect(resolveModelForMetadata("openrouter:anthropic/claude-sonnet-4-6", config)).toBe(
      "custom:mapped-model"
    );
  });

  test("gateway-scoped entry beats canonical when both exist", () => {
    const config: ProvidersConfigMap = {
      openrouter: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "anthropic/claude-sonnet-4-6", contextWindowTokens: 50000 }],
      },
      anthropic: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "claude-sonnet-4-6", contextWindowTokens: 200000 }],
      },
    };

    expect(getModelContextWindowOverride("openrouter:anthropic/claude-sonnet-4-6", config)).toBe(
      50000
    );
  });

  test("canonical fallback works when no gateway-scoped entry exists", () => {
    const config: ProvidersConfigMap = {
      anthropic: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "claude-sonnet-4-6", contextWindowTokens: 200000 }],
      },
    };

    expect(getModelContextWindowOverride("openrouter:anthropic/claude-sonnet-4-6", config)).toBe(
      200000
    );
  });
});

describe("getProviderModelEntryMappedTo", () => {
  test("returns null for string entry", () => {
    expect(getProviderModelEntryMappedTo("model-id")).toBeNull();
  });

  test("returns null for object entry without mapping", () => {
    expect(getProviderModelEntryMappedTo({ id: "model-id" })).toBeNull();
  });

  test("returns mapping for object entry with mapping", () => {
    expect(
      getProviderModelEntryMappedTo({
        id: "model-id",
        mappedToModel: "anthropic:claude-sonnet-4-6",
      })
    ).toBe("anthropic:claude-sonnet-4-6");
  });
});

describe("normalizeProviderModelEntry", () => {
  test("preserves string entry", () => {
    expect(normalizeProviderModelEntry("foo")).toBe("foo");
  });

  test("preserves object with contextWindowTokens only", () => {
    expect(normalizeProviderModelEntry({ id: "foo", contextWindowTokens: 128000 })).toEqual({
      id: "foo",
      contextWindowTokens: 128000,
    });
  });

  test("preserves object with mappedToModel only", () => {
    expect(
      normalizeProviderModelEntry({ id: "foo", mappedToModel: "anthropic:claude-sonnet-4-6" })
    ).toEqual({
      id: "foo",
      mappedToModel: "anthropic:claude-sonnet-4-6",
    });
  });

  test("preserves object with both fields", () => {
    expect(
      normalizeProviderModelEntry({
        id: "foo",
        contextWindowTokens: 128000,
        mappedToModel: "anthropic:claude-sonnet-4-6",
      })
    ).toEqual({
      id: "foo",
      contextWindowTokens: 128000,
      mappedToModel: "anthropic:claude-sonnet-4-6",
    });
  });

  test("ignores empty mappedToModel string", () => {
    expect(normalizeProviderModelEntry({ id: "foo", mappedToModel: "" })).toBe("foo");
  });

  test("ignores non-string mappedToModel", () => {
    expect(normalizeProviderModelEntry({ id: "foo", mappedToModel: 42 })).toBe("foo");
  });
});
