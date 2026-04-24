import { describe, expect, it } from "bun:test";
import { isCodexOauthAllowedModelId, isCodexOauthRequiredModelId } from "./codexOAuth";

describe("codexOAuth model gating", () => {
  it("allows GPT-5.4 mini through the Codex OAuth route", () => {
    expect(isCodexOauthAllowedModelId("gpt-5.4-mini")).toBe(true);
    expect(isCodexOauthAllowedModelId("openai:gpt-5.4-mini")).toBe(true);
  });

  it("allows GPT-5.5 through the Codex OAuth route", () => {
    expect(isCodexOauthAllowedModelId("gpt-5.5")).toBe(true);
    expect(isCodexOauthAllowedModelId("openai:gpt-5.5")).toBe(true);
  });

  it("does not allow GPT-5.4 nano through the Codex OAuth route", () => {
    expect(isCodexOauthAllowedModelId("gpt-5.4-nano")).toBe(false);
    expect(isCodexOauthAllowedModelId("openai:gpt-5.4-nano")).toBe(false);
  });

  it("marks GPT-5.5 as OAuth-required", () => {
    expect(isCodexOauthRequiredModelId("gpt-5.5")).toBe(true);
    expect(isCodexOauthRequiredModelId("openai:gpt-5.5")).toBe(true);
  });

  it("does not mark GPT-5.4 mini or nano as OAuth-required", () => {
    expect(isCodexOauthRequiredModelId("gpt-5.4-mini")).toBe(false);
    expect(isCodexOauthRequiredModelId("openai:gpt-5.4-mini")).toBe(false);
    expect(isCodexOauthRequiredModelId("gpt-5.4-nano")).toBe(false);
    expect(isCodexOauthRequiredModelId("openai:gpt-5.4-nano")).toBe(false);
  });
});
