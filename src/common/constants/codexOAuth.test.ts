import { describe, expect, it } from "bun:test";
import { isCodexOauthAllowedModelId, isCodexOauthRequiredModelId } from "./codexOAuth";

describe("codexOAuth model gating", () => {
  it("allows GPT-5.4 mini through the Codex OAuth route", () => {
    expect(isCodexOauthAllowedModelId("gpt-5.4-mini")).toBe(true);
    expect(isCodexOauthAllowedModelId("openai:gpt-5.4-mini")).toBe(true);
  });

  it("does not mark GPT-5.4 mini as OAuth-required", () => {
    expect(isCodexOauthRequiredModelId("gpt-5.4-mini")).toBe(false);
    expect(isCodexOauthRequiredModelId("openai:gpt-5.4-mini")).toBe(false);
  });
});
