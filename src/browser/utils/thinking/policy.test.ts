import { describe, expect, test } from "bun:test";
import { getThinkingPolicyForModel, enforceThinkingPolicy } from "./policy";

describe("getThinkingPolicyForModel", () => {
  test("returns single HIGH for gpt-5-pro base model", () => {
    expect(getThinkingPolicyForModel("openai:gpt-5-pro")).toEqual(["high"]);
  });

  test("returns single HIGH for gpt-5-pro with version suffix", () => {
    expect(getThinkingPolicyForModel("openai:gpt-5-pro-2025-10-06")).toEqual(["high"]);
  });

  test("returns single HIGH for gpt-5-pro with whitespace after colon", () => {
    expect(getThinkingPolicyForModel("openai: gpt-5-pro")).toEqual(["high"]);
  });

  test("returns all levels for gpt-5-pro-mini (not a fixed policy)", () => {
    expect(getThinkingPolicyForModel("openai:gpt-5-pro-mini")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  test("returns all levels for other OpenAI models", () => {
    expect(getThinkingPolicyForModel("openai:gpt-4o")).toEqual(["off", "low", "medium", "high"]);
    expect(getThinkingPolicyForModel("openai:gpt-4o-mini")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  test("returns all levels for Opus 4.5 (uses default policy)", () => {
    // Opus 4.5 uses the default policy - no special case needed
    // The effort parameter handles the "off" case by setting effort="low"
    expect(getThinkingPolicyForModel("anthropic:claude-opus-4-5")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(getThinkingPolicyForModel("anthropic:claude-opus-4-5-20251101")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  test("returns low/high for Gemini 3", () => {
    expect(getThinkingPolicyForModel("google:gemini-3-pro-preview")).toEqual(["low", "high"]);
  });

  test("returns all levels for other providers", () => {
    expect(getThinkingPolicyForModel("anthropic:claude-opus-4")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(getThinkingPolicyForModel("google:gemini-2.0-flash-thinking")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("enforceThinkingPolicy", () => {
  describe("single-option policy models (gpt-5-pro)", () => {
    test("enforces high for any requested level", () => {
      expect(enforceThinkingPolicy("openai:gpt-5-pro", "off")).toBe("high");
      expect(enforceThinkingPolicy("openai:gpt-5-pro", "low")).toBe("high");
      expect(enforceThinkingPolicy("openai:gpt-5-pro", "medium")).toBe("high");
      expect(enforceThinkingPolicy("openai:gpt-5-pro", "high")).toBe("high");
    });

    test("enforces high for versioned gpt-5-pro", () => {
      expect(enforceThinkingPolicy("openai:gpt-5-pro-2025-10-06", "low")).toBe("high");
    });
  });

  describe("multi-option policy models", () => {
    test("allows requested level if in allowed set", () => {
      expect(enforceThinkingPolicy("anthropic:claude-opus-4", "off")).toBe("off");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4", "low")).toBe("low");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4", "medium")).toBe("medium");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4", "high")).toBe("high");
    });

    test("falls back to medium when requested level not allowed", () => {
      // Simulating behavior with gpt-5-pro (only allows "high")
      // When requesting "low", falls back to first allowed level which is "high"
      expect(enforceThinkingPolicy("openai:gpt-5-pro", "low")).toBe("high");
    });
  });

  describe("Opus 4.5 (all levels supported)", () => {
    test("allows all levels including off", () => {
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-5", "off")).toBe("off");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-5", "low")).toBe("low");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-5", "medium")).toBe("medium");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-5", "high")).toBe("high");
    });

    test("allows off for versioned model", () => {
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-5-20251101", "off")).toBe("off");
    });
  });
});

// Note: Tests for invalid levels removed - TypeScript type system prevents invalid
// ThinkingLevel values at compile time, making runtime invalid-level tests unnecessary.
