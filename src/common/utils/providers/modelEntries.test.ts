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

  // New format tests: openai-compatible/{instanceId}:{modelId}
  test("returns original model for openai-compatible new format without config", () => {
    expect(resolveModelForMetadata("openai-compatible/together-ai:llama-3-1-70b", null)).toBe(
      "openai-compatible/together-ai:llama-3-1-70b"
    );
  });

  test("returns original model for openai-compatible new format when not found", () => {
    const config: ProvidersConfigMap = {
      "openai-compatible/other-provider": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        baseUrl: "https://other.example.com",
        models: ["some-model"],
      },
    };

    expect(resolveModelForMetadata("openai-compatible/together-ai:llama-3-1-70b", config)).toBe(
      "openai-compatible/together-ai:llama-3-1-70b"
    );
  });

  test("returns mapped model for openai-compatible new format when mapping exists", () => {
    const config: ProvidersConfigMap = {
      "openai-compatible/together-ai": {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        baseUrl: "https://api.together.xyz",
        models: [
          {
            id: "llama-3-1-70b",
            mappedToModel: "anthropic:claude-sonnet-4-6",
          },
        ],
      },
    };

    expect(resolveModelForMetadata("openai-compatible/together-ai:llama-3-1-70b", config)).toBe(
      "anthropic:claude-sonnet-4-6"
    );
  });
});

describe("getModelContextWindowOverride", () => {
  test("returns null for openai-compatible new format without config", () => {
    expect(getModelContextWindowOverride("openai-compatible/together-ai:llama-3-1-70b", null)).toBe(
      null
    );
  });

  test("returns null for openai-compatible new format when model not found", () => {
    const config: ProvidersConfigMap = {
      "openai-compatible/other-provider": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        baseUrl: "https://other.example.com",
        models: ["some-model"],
      },
    };

    expect(
      getModelContextWindowOverride("openai-compatible/together-ai:llama-3-1-70b", config)
    ).toBe(null);
  });

  test("returns context window for openai-compatible new format model", () => {
    const config: ProvidersConfigMap = {
      "openai-compatible/together-ai": {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        baseUrl: "https://api.together.xyz",
        models: [
          {
            id: "llama-3-1-70b",
            contextWindowTokens: 131072,
          },
        ],
      },
    };

    expect(
      getModelContextWindowOverride("openai-compatible/together-ai:llama-3-1-70b", config)
    ).toBe(131072);
  });

  test("returns null for standard provider without configWindowTokens", () => {
    const config: ProvidersConfigMap = {
      ollama: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        models: ["llama3"],
      },
    };

    expect(getModelContextWindowOverride("ollama:llama3", config)).toBe(null);
  });

  test("returns context window for standard provider", () => {
    const config: ProvidersConfigMap = {
      ollama: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "llama3", contextWindowTokens: 8192 }],
      },
    };

    expect(getModelContextWindowOverride("ollama:llama3", config)).toBe(8192);
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
