import { describe, expect, test } from "bun:test";
import {
  coerceThinkingLevel,
  getThinkingDisplayLabel,
  getThinkingOptionLabel,
  MAX_THINKING_INDEX,
  parseThinkingInput,
} from "./thinking";

describe("getThinkingDisplayLabel", () => {
  test("returns MAX for xhigh/max on Anthropic models", () => {
    expect(getThinkingDisplayLabel("xhigh", "anthropic:claude-opus-4-6")).toBe("MAX");
    expect(getThinkingDisplayLabel("max", "anthropic:claude-opus-4-6")).toBe("MAX");
    expect(getThinkingDisplayLabel("xhigh", "mux-gateway:anthropic/claude-opus-4-6")).toBe("MAX");
    expect(getThinkingDisplayLabel("xhigh", "anthropic:claude-opus-4-5")).toBe("MAX");
  });

  test("returns XHIGH for xhigh/max on OpenAI models", () => {
    expect(getThinkingDisplayLabel("xhigh", "openai:gpt-5.2")).toBe("XHIGH");
    expect(getThinkingDisplayLabel("max", "openai:gpt-5.2")).toBe("XHIGH");
    expect(getThinkingDisplayLabel("xhigh", "mux-gateway:openai/gpt-5.2")).toBe("XHIGH");
    expect(getThinkingDisplayLabel("max", "mux-gateway:openai/gpt-5.2")).toBe("XHIGH");
  });

  test("returns MAX for xhigh/max when no model specified (default)", () => {
    expect(getThinkingDisplayLabel("xhigh")).toBe("MAX");
    expect(getThinkingDisplayLabel("max")).toBe("MAX");
  });

  test("returns standard labels for non-xhigh levels regardless of model", () => {
    expect(getThinkingDisplayLabel("off", "anthropic:claude-opus-4-6")).toBe("OFF");
    expect(getThinkingDisplayLabel("low", "anthropic:claude-opus-4-6")).toBe("LOW");
    expect(getThinkingDisplayLabel("medium", "anthropic:claude-opus-4-6")).toBe("MED");
    expect(getThinkingDisplayLabel("high", "anthropic:claude-opus-4-6")).toBe("HIGH");
  });
});

describe("getThinkingOptionLabel", () => {
  test("renders max for xhigh on Anthropic models", () => {
    expect(getThinkingOptionLabel("xhigh", "anthropic:claude-opus-4-6")).toBe("max");
  });

  test("renders xhigh for xhigh/max on OpenAI models", () => {
    expect(getThinkingOptionLabel("xhigh", "openai:gpt-5.2")).toBe("xhigh");
    expect(getThinkingOptionLabel("max", "openai:gpt-5.2")).toBe("xhigh");
  });

  test("preserves non-xhigh labels", () => {
    expect(getThinkingOptionLabel("medium", "anthropic:claude-opus-4-6")).toBe("medium");
  });
});

describe("coerceThinkingLevel", () => {
  test("normalizes shorthand aliases", () => {
    expect(coerceThinkingLevel("med")).toBe("medium");
  });

  test("passes through all canonical levels including max", () => {
    expect(coerceThinkingLevel("off")).toBe("off");
    expect(coerceThinkingLevel("low")).toBe("low");
    expect(coerceThinkingLevel("medium")).toBe("medium");
    expect(coerceThinkingLevel("high")).toBe("high");
    expect(coerceThinkingLevel("xhigh")).toBe("xhigh");
    expect(coerceThinkingLevel("max")).toBe("max");
  });

  test("returns undefined for invalid values", () => {
    expect(coerceThinkingLevel("invalid")).toBeUndefined();
    expect(coerceThinkingLevel(42)).toBeUndefined();
    expect(coerceThinkingLevel(null)).toBeUndefined();
  });
});

describe("parseThinkingInput", () => {
  test.each([
    ["off", "off"],
    ["low", "low"],
    ["med", "medium"],
    ["medium", "medium"],
    ["high", "high"],
    ["max", "max"],
    ["xhigh", "xhigh"],
    ["OFF", "off"],
    ["MED", "medium"],
    ["High", "high"],
  ] as const)("parses named level %s → %s", (input, expected) => {
    expect(parseThinkingInput(input)).toBe(expected);
  });

  // Numeric indices are returned as raw numbers (resolved against model policy at send time)
  test.each([
    ["0", 0],
    ["1", 1],
    ["2", 2],
    ["3", 3],
    ["4", 4],
    ["9", 9],
  ] as const)("parses numeric level %s → %s", (input, expected) => {
    expect(parseThinkingInput(input)).toBe(expected);
  });

  test.each(["-1", "10", "99", "foo", "mediun", "1.5", "", "  "])(
    "returns undefined for invalid input %j",
    (input) => {
      expect(parseThinkingInput(input)).toBeUndefined();
    }
  );

  test("trims whitespace", () => {
    expect(parseThinkingInput("  high  ")).toBe("high");
    // Numeric with whitespace returns a number
    expect(parseThinkingInput(" 2 ")).toBe(2);
  });
});

describe("MAX_THINKING_INDEX", () => {
  test("is 9 (generous upper bound for numeric indices)", () => {
    expect(MAX_THINKING_INDEX).toBe(9);
  });
});
