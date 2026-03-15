import { describe, it, expect } from "bun:test";
import {
  getExplicitGatewayPrefix,
  normalizeSelectedModel,
  normalizeToCanonical,
  getModelName,
  getAnthropic1MContextMode,
  hasNative1MContext,
  supports1MContext,
  isValidModelFormat,
} from "./models";

describe("normalizeToCanonical", () => {
  it("normalizes mux-gateway model IDs to canonical identity", () => {
    expect(normalizeToCanonical("mux-gateway:anthropic/claude-opus-4-5")).toBe(
      "anthropic:claude-opus-4-5"
    );
    expect(normalizeToCanonical("mux-gateway:openai/gpt-4o")).toBe("openai:gpt-4o");
    expect(normalizeToCanonical("mux-gateway:google/gemini-2.5-pro")).toBe("google:gemini-2.5-pro");
  });

  it("normalizes bedrock model IDs to canonical anthropic identity", () => {
    expect(normalizeToCanonical("bedrock:anthropic.claude-sonnet-4-5")).toBe(
      "anthropic:claude-sonnet-4-5"
    );
    expect(normalizeToCanonical("bedrock:anthropic.claude-opus-4-6")).toBe(
      "anthropic:claude-opus-4-6"
    );
  });

  it("leaves bedrock model IDs unchanged when origin is not a known direct provider", () => {
    expect(normalizeToCanonical("bedrock:us.anthropic.claude-sonnet-4-5")).toBe(
      "bedrock:us.anthropic.claude-sonnet-4-5"
    );
  });

  it("leaves bedrock model IDs unchanged when no dot separator exists", () => {
    expect(normalizeToCanonical("bedrock:some-model-without-dots")).toBe(
      "bedrock:some-model-without-dots"
    );
  });

  it("normalizes openrouter model IDs to canonical identity", () => {
    expect(normalizeToCanonical("openrouter:openai/gpt-5")).toBe("openai:gpt-5");
    expect(normalizeToCanonical("openrouter:anthropic/claude-sonnet-4-5")).toBe(
      "anthropic:claude-sonnet-4-5"
    );
  });

  it("leaves github-copilot model IDs unchanged", () => {
    expect(normalizeToCanonical("github-copilot:gpt-5.4")).toBe("github-copilot:gpt-5.4");
  });

  it("leaves direct provider model IDs unchanged", () => {
    expect(normalizeToCanonical("anthropic:claude-sonnet-4-5")).toBe("anthropic:claude-sonnet-4-5");
    expect(normalizeToCanonical("openai:gpt-5")).toBe("openai:gpt-5");
    expect(normalizeToCanonical("claude-opus-4-5")).toBe("claude-opus-4-5");
  });

  it("returns malformed gateway strings unchanged", () => {
    expect(normalizeToCanonical("mux-gateway:no-slash-here")).toBe("mux-gateway:no-slash-here");
  });
});

describe("getExplicitGatewayPrefix", () => {
  it("returns the gateway provider name for explicit gateway-scoped model strings", () => {
    expect(getExplicitGatewayPrefix("openrouter:openai/gpt-5")).toBe("openrouter");
    expect(getExplicitGatewayPrefix("mux-gateway:anthropic/claude-sonnet-4-5")).toBe("mux-gateway");
    expect(getExplicitGatewayPrefix("bedrock:anthropic.claude-sonnet-4-5")).toBe("bedrock");
  });

  it("returns undefined for direct providers and malformed model strings", () => {
    expect(getExplicitGatewayPrefix("openai:gpt-5")).toBeUndefined();
    expect(getExplicitGatewayPrefix("anthropic:claude-sonnet-4-5")).toBeUndefined();
    expect(getExplicitGatewayPrefix("no-colon-model-string")).toBeUndefined();
  });
});

describe("normalizeSelectedModel", () => {
  it("preserves explicit gateway-scoped model selections", () => {
    expect(normalizeSelectedModel(" openrouter:openai/gpt-5 ")).toBe("openrouter:openai/gpt-5");
    expect(normalizeSelectedModel("mux-gateway:anthropic/claude-sonnet-4-5")).toBe(
      "mux-gateway:anthropic/claude-sonnet-4-5"
    );
    expect(normalizeSelectedModel("github-copilot:claude-sonnet-4-5")).toBe(
      "github-copilot:claude-sonnet-4-5"
    );
    expect(normalizeSelectedModel("bedrock:anthropic.claude-haiku-4-5")).toBe(
      "bedrock:anthropic.claude-haiku-4-5"
    );
  });

  it("keeps direct-provider selections canonical", () => {
    expect(normalizeSelectedModel(" openai:gpt-5 ")).toBe("openai:gpt-5");
    expect(normalizeSelectedModel("anthropic:claude-haiku-4-5")).toBe("anthropic:claude-haiku-4-5");
  });
});
describe("getModelName", () => {
  it("should extract model name from provider:model format", () => {
    expect(getModelName("anthropic:claude-opus-4-5")).toBe("claude-opus-4-5");
    expect(getModelName("openai:gpt-4o")).toBe("gpt-4o");
  });

  it("should handle mux-gateway format", () => {
    expect(getModelName("mux-gateway:anthropic/claude-opus-4-5")).toBe("claude-opus-4-5");
    expect(getModelName("mux-gateway:openai/gpt-4o")).toBe("gpt-4o");
  });

  it("should return full string if no colon", () => {
    expect(getModelName("claude-opus-4-5")).toBe("claude-opus-4-5");
  });
});

describe("Anthropic 1M context classification", () => {
  it("treats Sonnet 4 / 4.5 as beta-only 1M models", () => {
    expect(getAnthropic1MContextMode("anthropic:claude-sonnet-4-20250514")).toBe("beta");
    expect(getAnthropic1MContextMode("anthropic:claude-sonnet-4-5")).toBe("beta");
    expect(getAnthropic1MContextMode("anthropic:claude-sonnet-4-5-20250514")).toBe("beta");
    expect(getAnthropic1MContextMode("mux-gateway:anthropic/claude-sonnet-4-5")).toBe("beta");
    expect(supports1MContext("anthropic:claude-sonnet-4-20250514")).toBe(true);
    expect(supports1MContext("anthropic:claude-sonnet-4-5")).toBe(true);
    expect(hasNative1MContext("anthropic:claude-sonnet-4-5")).toBe(false);
  });

  it("treats Opus 4.6 and Sonnet 4.6 as native 1M models", () => {
    expect(getAnthropic1MContextMode("anthropic:claude-opus-4-6")).toBe("native");
    expect(getAnthropic1MContextMode("anthropic:claude-opus-4-6-20260201")).toBe("native");
    expect(getAnthropic1MContextMode("anthropic:claude-sonnet-4-6")).toBe("native");
    expect(getAnthropic1MContextMode("anthropic:claude-sonnet-4-6-20251022")).toBe("native");
    expect(getAnthropic1MContextMode("mux-gateway:anthropic/claude-sonnet-4-6")).toBe("native");
    expect(supports1MContext("anthropic:claude-opus-4-6")).toBe(false);
    expect(supports1MContext("anthropic:claude-sonnet-4-6")).toBe(false);
    expect(hasNative1MContext("anthropic:claude-opus-4-6")).toBe(true);
    expect(hasNative1MContext("anthropic:claude-sonnet-4-6")).toBe(true);
  });

  it("returns none for models without Anthropic 1M support", () => {
    expect(getAnthropic1MContextMode("anthropic:claude-opus-4-5")).toBe("none");
    expect(getAnthropic1MContextMode("anthropic:claude-haiku-4-5")).toBe("none");
    expect(getAnthropic1MContextMode("openai:gpt-5.4")).toBe("none");
    expect(getAnthropic1MContextMode("openai:gpt-5.2")).toBe("none");
    expect(supports1MContext("openai:gpt-5.4")).toBe(false);
    expect(supports1MContext("anthropic:claude-haiku-4-5")).toBe(false);
    expect(hasNative1MContext("openai:gpt-5.4")).toBe(false);
  });
});

describe("isValidModelFormat", () => {
  it("returns true for valid model formats", () => {
    expect(isValidModelFormat("anthropic:claude-sonnet-4-5")).toBe(true);
    expect(isValidModelFormat("openai:gpt-5.2")).toBe(true);
    expect(isValidModelFormat("google:gemini-3.1-pro-preview")).toBe(true);
    expect(isValidModelFormat("mux-gateway:anthropic/claude-opus-4-5")).toBe(true);
    // Ollama-style model names with colons in the model ID
    expect(isValidModelFormat("ollama:gpt-oss:20b")).toBe(true);
  });

  it("returns false for invalid model formats", () => {
    // Missing colon
    expect(isValidModelFormat("gpt")).toBe(false);
    expect(isValidModelFormat("sonnet")).toBe(false);
    expect(isValidModelFormat("badmodel")).toBe(false);

    // Colon at start or end
    expect(isValidModelFormat(":model")).toBe(false);
    expect(isValidModelFormat("provider:")).toBe(false);

    // Empty string
    expect(isValidModelFormat("")).toBe(false);
  });
});
