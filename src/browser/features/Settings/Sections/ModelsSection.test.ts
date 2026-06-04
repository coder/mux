import { describe, expect, test } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import {
  buildUpdatedModelParameters,
  parseBoundedNumberInput,
  parsePositiveIntegerInput,
  shouldAllowRouteOverrideInSettings,
  shouldShowModelInSettings,
} from "./ModelsSection";

describe("shouldShowModelInSettings", () => {
  test("hides OAuth-required Codex model when OpenAI OAuth is not configured", () => {
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT_53_CODEX_SPARK.id, false)).toBe(false);
  });

  test("shows OAuth-required Codex model when OpenAI OAuth is configured", () => {
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT_53_CODEX_SPARK.id, true)).toBe(true);
  });

  test("shows GPT-5.5 when OpenAI OAuth is not configured", () => {
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT.id, false)).toBe(true);
  });

  test("shows GPT-5.5 Pro when OpenAI OAuth is not configured", () => {
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT_PRO.id, false)).toBe(true);
  });

  test("does not gate non-OpenAI models that share the same model id", () => {
    expect(shouldShowModelInSettings("openrouter:gpt-5.3-codex-spark", false)).toBe(true);
  });

  test("keeps gpt-5.3-codex visible without OAuth", () => {
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT_53_CODEX.id, false)).toBe(true);
  });

  test("keeps non-required OpenAI models visible without OAuth", () => {
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT.id, false)).toBe(true);
  });
});

describe("shouldAllowRouteOverrideInSettings", () => {
  test("disables route overrides for explicit gateway rows", () => {
    expect(shouldAllowRouteOverrideInSettings("openrouter:openai/gpt-5")).toBe(false);
  });

  test("keeps route overrides enabled for canonical rows", () => {
    expect(shouldAllowRouteOverrideInSettings("openai:gpt-5")).toBe(true);
  });

  test("keeps route overrides enabled for direct custom providers", () => {
    expect(shouldAllowRouteOverrideInSettings("ollama:gpt-oss:20b")).toBe(true);
  });
});

describe("model parameter edit helpers", () => {
  test("parses positive integer input for max_output_tokens", () => {
    expect(parsePositiveIntegerInput("42")).toBe(42);
    expect(parsePositiveIntegerInput("0")).toBeNull();
    expect(parsePositiveIntegerInput("1.5")).toBeNull();
    expect(parsePositiveIntegerInput("abc")).toBeNull();
  });

  test("parses bounded decimal input for temperature and top_p", () => {
    expect(parseBoundedNumberInput("0", 0, 2)).toBe(0);
    expect(parseBoundedNumberInput("1.5", 0, 2)).toBe(1.5);
    expect(parseBoundedNumberInput("2", 0, 2)).toBe(2);
    expect(parseBoundedNumberInput("2.1", 0, 2)).toBeNull();
    expect(parseBoundedNumberInput("-0.1", 0, 1)).toBeNull();
  });

  test("buildUpdatedModelParameters updates overrides and clears renamed entries", () => {
    const withRenamed = buildUpdatedModelParameters(
      {
        legacy: { temperature: 0.2 },
      },
      "legacy",
      {
        max_output_tokens: null,
        temperature: null,
        top_p: null,
      }
    );

    expect(withRenamed).toBeUndefined();

    const withNewOverrides = buildUpdatedModelParameters(withRenamed, "renamed", {
      max_output_tokens: 2048,
      temperature: 0.5,
      top_p: null,
    });

    expect(withNewOverrides).toEqual({
      renamed: {
        max_output_tokens: 2048,
        temperature: 0.5,
      },
    });
  });
});
