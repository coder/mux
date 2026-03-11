import { describe, it, expect } from "bun:test";
import {
  getExplicitGatewayPrefix,
  normalizeSelectedModel,
  normalizeToCanonical,
  getModelName,
  supports1MContext,
  isValidModelFormat,
} from "./models";

describe("normalizeToCanonical", () => {
  it("should convert mux-gateway:provider/model to provider:model", () => {
    expect(normalizeToCanonical("mux-gateway:anthropic/claude-opus-4-5")).toBe(
      "anthropic:claude-opus-4-5"
    );
    expect(normalizeToCanonical("mux-gateway:openai/gpt-4o")).toBe("openai:gpt-4o");
    expect(normalizeToCanonical("mux-gateway:google/gemini-2.5-pro")).toBe("google:gemini-2.5-pro");
  });

  it("should keep github-copilot:model identities unchanged", () => {
    expect(normalizeToCanonical("github-copilot:gpt-5.4")).toBe("github-copilot:gpt-5.4");
  });

  it("should return non-gateway strings unchanged", () => {
    expect(normalizeToCanonical("anthropic:claude-opus-4-5")).toBe("anthropic:claude-opus-4-5");
    expect(normalizeToCanonical("openai:gpt-4o")).toBe("openai:gpt-4o");
    expect(normalizeToCanonical("claude-opus-4-5")).toBe("claude-opus-4-5");
  });

  it("should return malformed gateway strings unchanged", () => {
    // No slash in the inner part
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

describe("supports1MContext", () => {
  it("should return true for Anthropic Sonnet 4 models", () => {
    expect(supports1MContext("anthropic:claude-sonnet-4-5")).toBe(true);
    expect(supports1MContext("anthropic:claude-sonnet-4-5-20250514")).toBe(true);
    expect(supports1MContext("anthropic:claude-sonnet-4-20250514")).toBe(true);
  });

  it("should return true for mux-gateway Sonnet 4 models", () => {
    expect(supports1MContext("mux-gateway:anthropic/claude-sonnet-4-5")).toBe(true);
    expect(supports1MContext("mux-gateway:anthropic/claude-sonnet-4-5-20250514")).toBe(true);
  });

  it("should return false for OpenAI GPT models with native large context", () => {
    expect(supports1MContext("openai:gpt-5.4")).toBe(false);
    expect(supports1MContext("openai:gpt-5.4-2026-03-05")).toBe(false);
    expect(supports1MContext("openai:gpt-5.4-pro")).toBe(false);
    expect(supports1MContext("openai:gpt-5.4-pro-2026-03-05")).toBe(false);
    expect(supports1MContext("mux-gateway:openai/gpt-5.4")).toBe(false);
    expect(supports1MContext("mux-gateway:openai/gpt-5.4-pro")).toBe(false);
  });

  it("should return false for other OpenAI models", () => {
    expect(supports1MContext("openai:gpt-5.2")).toBe(false);
    expect(supports1MContext("openai:gpt-4o")).toBe(false);
    expect(supports1MContext("mux-gateway:openai/gpt-4o")).toBe(false);
  });

  it("should return true for Opus 4.6 models", () => {
    expect(supports1MContext("anthropic:claude-opus-4-6")).toBe(true);
    expect(supports1MContext("mux-gateway:anthropic/claude-opus-4-6")).toBe(true);
  });

  it("should return false for Anthropic non-Sonnet-4 / non-Opus-4.6 models", () => {
    expect(supports1MContext("anthropic:claude-opus-4-5")).toBe(false);
    expect(supports1MContext("anthropic:claude-haiku-4-5")).toBe(false);
    expect(supports1MContext("mux-gateway:anthropic/claude-opus-4-5")).toBe(false);
  });

  it("should return true for Opus 4.6 models", () => {
    expect(supports1MContext("anthropic:claude-opus-4-6")).toBe(true);
    expect(supports1MContext("anthropic:claude-opus-4-6-20260201")).toBe(true);
    expect(supports1MContext("mux-gateway:anthropic/claude-opus-4-6")).toBe(true);
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
