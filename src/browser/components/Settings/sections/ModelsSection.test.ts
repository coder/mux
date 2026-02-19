import { describe, expect, test } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { shouldShowModelInSettings } from "./ModelsSection";

describe("shouldShowModelInSettings", () => {
  test("hides OAuth-required Codex model when OpenAI OAuth is not configured", () => {
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT_53_CODEX.id, false)).toBe(false);
  });

  test("shows OAuth-required Codex model when OpenAI OAuth is configured", () => {
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT_53_CODEX.id, true)).toBe(true);
  });

  test("does not gate non-OpenAI models that share the same model id", () => {
    expect(shouldShowModelInSettings("openrouter:gpt-5.3-codex", false)).toBe(true);
  });
  test("keeps non-required OpenAI models visible without OAuth", () => {
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT.id, false)).toBe(true);
  });
});
