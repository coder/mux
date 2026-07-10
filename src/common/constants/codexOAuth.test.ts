import { describe, expect, it } from "bun:test";
import {
  isCodexOauthAllowedModel,
  isCodexOauthAllowedModelId,
  isCodexOauthRequiredModel,
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

  it("allows the GPT-5.6 family through Codex OAuth without requiring it", () => {
    // Includes the bare alias: it is a servable model id (OpenAI routes it to Sol).
    for (const model of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(isCodexOauthAllowedModelId(model)).toBe(true);
      expect(isCodexOauthAllowedModelId(`openai:${model}`)).toBe(true);
      expect(isCodexOauthRequiredModelId(model)).toBe(false);
      expect(isCodexOauthRequiredModelId(`openai:${model}`)).toBe(false);
    }
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

  it("inherits OAuth compatibility from a mapped OpenAI model", () => {
    const config = {
      openai: {
        models: [
          { id: "team-codex", mappedToModel: "openai:gpt-5.3-codex" },
          { id: "team-bare", mappedToModel: "gpt-5.3-codex" },
          { id: "team-litellm", mappedToModel: "openai/gpt-5.3-codex" },
          { id: "team-spark", mappedToModel: "openai:gpt-5.3-codex-spark" },
        ],
      },
    };

    expect(isCodexOauthAllowedModel("openai:team-codex", config)).toBe(true);
    expect(isCodexOauthRequiredModel("openai:team-codex", config)).toBe(false);
    expect(isCodexOauthAllowedModel("openai:team-bare", config)).toBe(true);
    expect(isCodexOauthAllowedModel("openai:team-litellm", config)).toBe(true);
    expect(isCodexOauthAllowedModel("openai:team-spark", config)).toBe(true);
    expect(isCodexOauthRequiredModel("openai:team-spark", config)).toBe(true);
  });

  it("does not inherit OpenAI OAuth compatibility across providers", () => {
    const config = {
      openrouter: {
        models: [{ id: "team-codex", mappedToModel: "openai:gpt-5.3-codex" }],
      },
    };

    expect(isCodexOauthAllowedModel("openrouter:team-codex", config)).toBe(false);
  });

  it("does not mark GPT-5.4 mini or nano as OAuth-required", () => {
    expect(isCodexOauthRequiredModelId("gpt-5.4-mini")).toBe(false);
    expect(isCodexOauthRequiredModelId("openai:gpt-5.4-mini")).toBe(false);
    expect(isCodexOauthRequiredModelId("gpt-5.4-nano")).toBe(false);
    expect(isCodexOauthRequiredModelId("openai:gpt-5.4-nano")).toBe(false);
  });
});
