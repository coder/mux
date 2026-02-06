import { describe, expect, test } from "bun:test";
import { getThinkingDisplayLabel } from "./thinking";

describe("getThinkingDisplayLabel", () => {
  test("returns MAX for xhigh on Opus 4.6", () => {
    expect(getThinkingDisplayLabel("xhigh", "anthropic:claude-opus-4-6")).toBe("MAX");
  });

  test("returns MAX for xhigh on Opus 4.6 behind mux-gateway", () => {
    expect(getThinkingDisplayLabel("xhigh", "mux-gateway:anthropic/claude-opus-4-6")).toBe("MAX");
  });

  test("returns XHIGH for xhigh on non-Opus 4.6 models", () => {
    expect(getThinkingDisplayLabel("xhigh", "openai:gpt-5.2")).toBe("XHIGH");
    expect(getThinkingDisplayLabel("xhigh", "anthropic:claude-opus-4-5")).toBe("XHIGH");
  });

  test("returns XHIGH for xhigh when no model specified", () => {
    expect(getThinkingDisplayLabel("xhigh")).toBe("XHIGH");
  });

  test("returns standard labels for non-xhigh levels regardless of model", () => {
    expect(getThinkingDisplayLabel("off", "anthropic:claude-opus-4-6")).toBe("OFF");
    expect(getThinkingDisplayLabel("low", "anthropic:claude-opus-4-6")).toBe("LOW");
    expect(getThinkingDisplayLabel("medium", "anthropic:claude-opus-4-6")).toBe("MED");
    expect(getThinkingDisplayLabel("high", "anthropic:claude-opus-4-6")).toBe("HIGH");
  });
});
