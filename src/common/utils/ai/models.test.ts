import { describe, it, expect } from "bun:test";
import { normalizeGatewayModel, getModelName, supports1MContext } from "./models";

describe("normalizeGatewayModel", () => {
  it("should convert mux-gateway:provider/model to provider:model", () => {
    expect(normalizeGatewayModel("mux-gateway:anthropic/claude-opus-4-5")).toBe(
      "anthropic:claude-opus-4-5"
    );
    expect(normalizeGatewayModel("mux-gateway:openai/gpt-4o")).toBe("openai:gpt-4o");
    expect(normalizeGatewayModel("mux-gateway:google/gemini-2.5-pro")).toBe(
      "google:gemini-2.5-pro"
    );
  });

  it("should return non-gateway strings unchanged", () => {
    expect(normalizeGatewayModel("anthropic:claude-opus-4-5")).toBe("anthropic:claude-opus-4-5");
    expect(normalizeGatewayModel("openai:gpt-4o")).toBe("openai:gpt-4o");
    expect(normalizeGatewayModel("claude-opus-4-5")).toBe("claude-opus-4-5");
  });

  it("should return malformed gateway strings unchanged", () => {
    // No slash in the inner part
    expect(normalizeGatewayModel("mux-gateway:no-slash-here")).toBe("mux-gateway:no-slash-here");
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

  it("should return false for non-Anthropic models", () => {
    expect(supports1MContext("openai:gpt-4o")).toBe(false);
    expect(supports1MContext("mux-gateway:openai/gpt-4o")).toBe(false);
  });

  it("should return false for Anthropic non-Sonnet-4 models", () => {
    expect(supports1MContext("anthropic:claude-opus-4-5")).toBe(false);
    expect(supports1MContext("anthropic:claude-haiku-4-5")).toBe(false);
    expect(supports1MContext("mux-gateway:anthropic/claude-opus-4-5")).toBe(false);
  });
});
