import { describe, expect, it } from "bun:test";
import {
  getCodexOauthContextWindowOverride,
  isCodexOauthAllowedModelId,
  isCodexOauthRequiredModelId,
} from "./codexOAuth";

describe("codexOAuth model gating", () => {
  it("allows GPT-5.4 mini through the Codex OAuth route", () => {
    expect(isCodexOauthAllowedModelId("gpt-5.4-mini")).toBe(true);
    expect(isCodexOauthAllowedModelId("openai:gpt-5.4-mini")).toBe(true);
  });

  it("allows GPT-5.5 through Codex OAuth without requiring it", () => {
    expect(isCodexOauthAllowedModelId("gpt-5.5")).toBe(true);
    expect(isCodexOauthAllowedModelId("openai:gpt-5.5")).toBe(true);
    expect(isCodexOauthRequiredModelId("gpt-5.5")).toBe(false);
    expect(isCodexOauthRequiredModelId("openai:gpt-5.5")).toBe(false);
  });

  it("does not allow GPT-5.5 Pro through the Codex OAuth route", () => {
    expect(isCodexOauthAllowedModelId("gpt-5.5-pro")).toBe(false);
    expect(isCodexOauthAllowedModelId("openai:gpt-5.5-pro")).toBe(false);
    expect(isCodexOauthRequiredModelId("gpt-5.5-pro")).toBe(false);
    expect(isCodexOauthRequiredModelId("openai:gpt-5.5-pro")).toBe(false);
  });

  it("does not allow GPT-5.4 nano through the Codex OAuth route", () => {
    expect(isCodexOauthAllowedModelId("gpt-5.4-nano")).toBe(false);
    expect(isCodexOauthAllowedModelId("openai:gpt-5.4-nano")).toBe(false);
  });

  it("does not mark GPT-5.4 mini or nano as OAuth-required", () => {
    expect(isCodexOauthRequiredModelId("gpt-5.4-mini")).toBe(false);
    expect(isCodexOauthRequiredModelId("openai:gpt-5.4-mini")).toBe(false);
    expect(isCodexOauthRequiredModelId("gpt-5.4-nano")).toBe(false);
    expect(isCodexOauthRequiredModelId("openai:gpt-5.4-nano")).toBe(false);
  });

  it("allows GPT-5.6 Terra and Luna through Codex OAuth without requiring them", () => {
    expect(isCodexOauthAllowedModelId("gpt-5.6-terra")).toBe(true);
    expect(isCodexOauthAllowedModelId("openai:gpt-5.6-terra")).toBe(true);
    expect(isCodexOauthAllowedModelId("gpt-5.6-luna")).toBe(true);
    expect(isCodexOauthAllowedModelId("openai:gpt-5.6-luna")).toBe(true);
    expect(isCodexOauthRequiredModelId("gpt-5.6-terra")).toBe(false);
    expect(isCodexOauthRequiredModelId("gpt-5.6-luna")).toBe(false);
  });

  it("does not allow GPT-5.6 Sol through the Codex OAuth route", () => {
    expect(isCodexOauthAllowedModelId("gpt-5.6-sol")).toBe(false);
    expect(isCodexOauthAllowedModelId("openai:gpt-5.6-sol")).toBe(false);
    expect(isCodexOauthRequiredModelId("gpt-5.6-sol")).toBe(false);
  });

  it("caps GPT-5.6 Terra's OAuth context window at 272K but leaves Luna uncapped", () => {
    expect(getCodexOauthContextWindowOverride("gpt-5.6-terra")).toBe(272_000);
    expect(getCodexOauthContextWindowOverride("openai:gpt-5.6-terra")).toBe(272_000);
    expect(getCodexOauthContextWindowOverride("gpt-5.6-luna")).toBeNull();
    expect(getCodexOauthContextWindowOverride("openai:gpt-5.6-luna")).toBeNull();
  });
});
