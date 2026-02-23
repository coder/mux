import { describe, expect, test } from "bun:test";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import {
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
