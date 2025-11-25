import { describe, expect, test } from "bun:test";
import { getThinkingPolicyForModel, enforceThinkingPolicy } from "./policy";

describe("getThinkingPolicyForModel", () => {
  test("returns single HIGH for gpt-5-pro base model", () => {
    expect(getThinkingPolicyForModel("openai:gpt-5-pro")).toEqual(["high"]);
  });

  test("returns single HIGH for gpt-5-pro with version suffix", () => {
    expect(getThinkingPolicyForModel("openai:gpt-5-pro-2025-10-06")).toEqual(["high"]);
  });

  test("returns all levels for gpt-5-pro-mini (not a fixed policy)", () => {
    // gpt-5-pro-mini shouldn't match the gpt-5-pro config
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
    expect(getThinkingPolicyForModel("google:gemini-3-pro-preview")).toEqual(["low", "high"]);
  });

  test("returns binary on/off for xAI Grok models", () => {
    expect(getThinkingPolicyForModel("xai:grok-4-1-fast")).toEqual(["off", "high"]);
    expect(getThinkingPolicyForModel("xai:grok-2-latest")).toEqual(["off", "high"]);
    expect(getThinkingPolicyForModel("xai:grok-beta")).toEqual(["off", "high"]);
  });

  test("grok models with version suffixes also get binary policy", () => {
    expect(getThinkingPolicyForModel("xai:grok-4-1-fast-v2")).toEqual(["off", "high"]);
  });

  test("grok-code does not match grok- prefix, gets default policy", () => {
    expect(getThinkingPolicyForModel("xai:grok-code-fast-1")).toEqual([
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

    test("maps non-off levels to highest available when requested level not allowed", () => {
      // gpt-5-pro only allows "high"
      expect(enforceThinkingPolicy("openai:gpt-5-pro", "low")).toBe("high");
      expect(enforceThinkingPolicy("openai:gpt-5-pro", "medium")).toBe("high");

      // Grok only allows "off" and "high" - preserve reasoning intent
      expect(enforceThinkingPolicy("xai:grok-4-1-fast", "low")).toBe("high");
      expect(enforceThinkingPolicy("xai:grok-4-1-fast", "medium")).toBe("high");
      expect(enforceThinkingPolicy("xai:grok-4-1-fast", "off")).toBe("off");
    });
  });
});

// Note: Tests for invalid levels removed - TypeScript type system prevents invalid
// ThinkingLevel values at compile time, making runtime invalid-level tests unnecessary.
