import { describe, expect, test } from "bun:test";
import { getThinkingPolicyForModel, enforceThinkingPolicy, resolveThinkingInput } from "./policy";

describe("getThinkingPolicyForModel", () => {
  test("returns 5 levels including xhigh for gpt-5.1-codex-max", () => {
    expect(getThinkingPolicyForModel("openai:gpt-5.1-codex-max")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("returns 5 levels for gpt-5.1-codex-max with version suffix", () => {
    expect(getThinkingPolicyForModel("openai:gpt-5.1-codex-max-2025-12-01")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("returns 5 levels for bare gpt-5.1-codex-max without prefix", () => {
    expect(getThinkingPolicyForModel("gpt-5.1-codex-max")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("returns 5 levels for codex-max alias", () => {
    expect(getThinkingPolicyForModel("codex-max")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("returns 5 levels for gpt-5.1-codex-max with whitespace after colon", () => {
    expect(getThinkingPolicyForModel("openai: gpt-5.1-codex-max")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("returns medium/high/xhigh for gpt-5.2-pro", () => {
    expect(getThinkingPolicyForModel("openai:gpt-5.2-pro")).toEqual(["medium", "high", "xhigh"]);
  });

  test("returns medium/high/xhigh for gpt-5.2-pro behind mux-gateway", () => {
    expect(getThinkingPolicyForModel("mux-gateway:openai/gpt-5.2-pro")).toEqual([
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("returns 5 levels including xhigh for gpt-5.2-codex", () => {
    expect(getThinkingPolicyForModel("openai:gpt-5.2-codex")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("returns 5 levels including xhigh for gpt-5.2", () => {
    expect(getThinkingPolicyForModel("openai:gpt-5.2")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("returns 5 levels including xhigh for gpt-5.2 behind mux-gateway", () => {
    expect(getThinkingPolicyForModel("mux-gateway:openai/gpt-5.2")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("returns 5 levels including xhigh for gpt-5.2 with version suffix", () => {
    expect(getThinkingPolicyForModel("openai:gpt-5.2-2025-12-11")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("returns 5 levels including xhigh for gpt-5.1-codex-max behind mux-gateway", () => {
    expect(getThinkingPolicyForModel("mux-gateway:openai/gpt-5.1-codex-max")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
  test("returns medium/high/xhigh for gpt-5.2-pro with version suffix", () => {
    expect(getThinkingPolicyForModel("openai:gpt-5.2-pro-2025-12-11")).toEqual([
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("returns single HIGH for gpt-5-pro base model (legacy)", () => {
    expect(getThinkingPolicyForModel("openai:gpt-5-pro")).toEqual(["high"]);
  });

  test("returns single HIGH for gpt-5-pro with version suffix (legacy)", () => {
    expect(getThinkingPolicyForModel("openai:gpt-5-pro-2025-10-06")).toEqual(["high"]);
  });

  test("returns single HIGH for gpt-5-pro with whitespace after colon (legacy)", () => {
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

  test("returns 5 levels including xhigh for Opus 4.6", () => {
    expect(getThinkingPolicyForModel("anthropic:claude-opus-4-6")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getThinkingPolicyForModel("anthropic:claude-opus-4-6-20260201")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // Behind gateway
    expect(getThinkingPolicyForModel("mux-gateway:anthropic/claude-opus-4-6")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("returns 5 levels including xhigh for Sonnet 4.6", () => {
    expect(getThinkingPolicyForModel("anthropic:claude-sonnet-4-6")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getThinkingPolicyForModel("anthropic:claude-sonnet-4-6-20260201")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // Behind gateway
    expect(getThinkingPolicyForModel("mux-gateway:anthropic/claude-sonnet-4-6")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("returns low/high for Gemini 3.1 Pro", () => {
    expect(getThinkingPolicyForModel("google:gemini-3.1-pro-preview")).toEqual(["low", "high"]);
  });

  test("returns off/low/medium/high for Gemini 3 Flash", () => {
    expect(getThinkingPolicyForModel("google:gemini-3-flash-preview")).toEqual([
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

  describe("GPT-5.1-Codex-Max (5 levels including xhigh)", () => {
    test("allows all 5 levels including xhigh", () => {
      expect(enforceThinkingPolicy("openai:gpt-5.1-codex-max", "off")).toBe("off");
      expect(enforceThinkingPolicy("openai:gpt-5.1-codex-max", "low")).toBe("low");
      expect(enforceThinkingPolicy("openai:gpt-5.1-codex-max", "medium")).toBe("medium");
      expect(enforceThinkingPolicy("openai:gpt-5.1-codex-max", "high")).toBe("high");
      expect(enforceThinkingPolicy("openai:gpt-5.1-codex-max", "xhigh")).toBe("xhigh");
    });

    test("allows xhigh for versioned model", () => {
      expect(enforceThinkingPolicy("openai:gpt-5.1-codex-max-2025-12-01", "xhigh")).toBe("xhigh");
    });
  });

  describe("GPT-5.2 (5 levels including xhigh)", () => {
    test("allows xhigh for base model", () => {
      expect(enforceThinkingPolicy("openai:gpt-5.2", "xhigh")).toBe("xhigh");
    });

    test("allows xhigh behind mux-gateway", () => {
      expect(enforceThinkingPolicy("mux-gateway:openai/gpt-5.2", "xhigh")).toBe("xhigh");
    });

    test("allows xhigh for versioned model", () => {
      expect(enforceThinkingPolicy("openai:gpt-5.2-2025-12-11", "xhigh")).toBe("xhigh");
    });
  });

  describe("Opus 4.6 (5 levels including xhigh)", () => {
    test("allows all 5 levels including xhigh", () => {
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-6", "off")).toBe("off");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-6", "low")).toBe("low");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-6", "medium")).toBe("medium");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-6", "high")).toBe("high");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-6", "xhigh")).toBe("xhigh");
    });
  });

  describe("Sonnet 4.6 (5 levels including xhigh)", () => {
    test("allows all 5 levels including xhigh", () => {
      expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-6", "off")).toBe("off");
      expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-6", "low")).toBe("low");
      expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-6", "medium")).toBe("medium");
      expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-6", "high")).toBe("high");
      expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-6", "xhigh")).toBe("xhigh");
    });
  });

  describe("xhigh fallback for models without xhigh support", () => {
    test("clamps to highest allowed when xhigh requested on standard model", () => {
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-5", "xhigh")).toBe("high");
    });

    test("falls back to high when xhigh requested on gpt-5-pro", () => {
      expect(enforceThinkingPolicy("openai:gpt-5-pro", "xhigh")).toBe("high");
    });

    test("clamps xhigh to high for standard Anthropic models", () => {
      expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-5", "xhigh")).toBe("high");
    });
  });
});

// Note: Tests for invalid levels removed - TypeScript type system prevents invalid
// ThinkingLevel values at compile time, making runtime invalid-level tests unnecessary.
describe("resolveThinkingInput", () => {
  test("passes through named levels directly", () => {
    expect(resolveThinkingInput("off", "anthropic:claude-opus-4-1")).toBe("off");
    expect(resolveThinkingInput("high", "anthropic:claude-opus-4-1")).toBe("high");
    expect(resolveThinkingInput("medium", "openai:gpt-5.2-pro")).toBe("medium");
  });

  test("numeric 0 maps to model's lowest allowed level", () => {
    // Default models: lowest = "off"
    expect(resolveThinkingInput(0, "anthropic:claude-opus-4-1")).toBe("off");
    // gpt-5.2-pro: lowest = "medium"
    expect(resolveThinkingInput(0, "openai:gpt-5.2-pro")).toBe("medium");
    // gpt-5-pro: only "high"
    expect(resolveThinkingInput(0, "openai:gpt-5-pro")).toBe("high");
    // gemini-3: lowest = "low"
    expect(resolveThinkingInput(0, "google:gemini-3")).toBe("low");
  });

  test("numeric indices map through model's sorted allowed levels", () => {
    // Default: [off, low, medium, high] → 0=off, 1=low, 2=medium, 3=high
    expect(resolveThinkingInput(0, "anthropic:claude-sonnet-4-5")).toBe("off");
    expect(resolveThinkingInput(1, "anthropic:claude-sonnet-4-5")).toBe("low");
    expect(resolveThinkingInput(2, "anthropic:claude-sonnet-4-5")).toBe("medium");
    expect(resolveThinkingInput(3, "anthropic:claude-sonnet-4-5")).toBe("high");

    // gpt-5.2-pro: [medium, high, xhigh] → 0=medium, 1=high, 2=xhigh
    expect(resolveThinkingInput(0, "openai:gpt-5.2-pro")).toBe("medium");
    expect(resolveThinkingInput(1, "openai:gpt-5.2-pro")).toBe("high");
    expect(resolveThinkingInput(2, "openai:gpt-5.2-pro")).toBe("xhigh");
  });

  test("out-of-range numeric index clamps to model's highest level", () => {
    // Default has 4 levels, index 9 clamps to "high"
    expect(resolveThinkingInput(9, "anthropic:claude-sonnet-4-5")).toBe("high");
    // gpt-5-pro only has "high", any index clamps to "high"
    expect(resolveThinkingInput(5, "openai:gpt-5-pro")).toBe("high");
    // gpt-5.2-pro has 3 levels, index 4 clamps to "xhigh"
    expect(resolveThinkingInput(4, "openai:gpt-5.2-pro")).toBe("xhigh");
  });
});
