import { describe, expect, test } from "bun:test";
import {
  coerceThinkingLevel,
  getThinkingDisplayLabel,
  parseThinkingInput,
  NUMERIC_THINKING_LEVELS,
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

  test.each([
    ["0", "off"],
    ["1", "low"],
    ["2", "medium"],
    ["3", "high"],
    ["4", "max"],
  ] as const)("parses numeric level %s → %s", (input, expected) => {
    expect(parseThinkingInput(input)).toBe(expected);
  });

  test.each(["5", "-1", "99", "foo", "mediun", "1.5", "", "  "])(
    "returns undefined for invalid input %j",
    (input) => {
      expect(parseThinkingInput(input)).toBeUndefined();
    }
  );

  test("trims whitespace", () => {
    expect(parseThinkingInput("  high  ")).toBe("high");
    expect(parseThinkingInput(" 2 ")).toBe("medium");
  });
});

describe("NUMERIC_THINKING_LEVELS", () => {
  test("has 5 levels (0–4)", () => {
    expect(NUMERIC_THINKING_LEVELS).toHaveLength(5);
  });

  test("maps index 0 to off and index 4 to max", () => {
    expect(NUMERIC_THINKING_LEVELS[0]).toBe("off");
    expect(NUMERIC_THINKING_LEVELS[4]).toBe("max");
  });
});
