import { describe, expect, it } from "bun:test";

import { normalizeModelInput } from "./normalizeModelInput";

describe("normalizeModelInput", () => {
  it("preserves explicit gateway-scoped model strings for the backend", () => {
    expect(normalizeModelInput("openrouter:openai/gpt-5")).toEqual({
      model: "openrouter:openai/gpt-5",
      isAlias: false,
    });
    expect(normalizeModelInput("mux-gateway:anthropic/claude-sonnet-4-6")).toEqual({
      model: "mux-gateway:anthropic/claude-sonnet-4-6",
      isAlias: false,
    });
    expect(normalizeModelInput("github-copilot:gpt-5.4")).toEqual({
      model: "github-copilot:gpt-5.4",
      isAlias: false,
    });
  });

  it("keeps direct providers normalized as before", () => {
    expect(normalizeModelInput("openai:gpt-5")).toEqual({
      model: "openai:gpt-5",
      isAlias: false,
    });
    expect(normalizeModelInput("anthropic:claude-opus-4-6")).toEqual({
      model: "anthropic:claude-opus-4-6",
      isAlias: false,
    });
  });

  it("returns null for null and empty inputs", () => {
    expect(normalizeModelInput(null)).toEqual({ model: null, isAlias: false });
    expect(normalizeModelInput("")).toEqual({ model: null, isAlias: false });
    expect(normalizeModelInput("   ")).toEqual({ model: null, isAlias: false });
  });

  it("keeps slash-format provider/model inputs invalid as before", () => {
    expect(normalizeModelInput("openai/gpt-5")).toEqual({
      model: null,
      isAlias: false,
      error: "invalid-format",
    });
  });
});
