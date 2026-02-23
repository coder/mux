import { describe, expect, test } from "bun:test";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { calculateTokenMeterData, formatTokens } from "./tokenMeterUtils";

const SAMPLE_USAGE = {
  input: { tokens: 10_000 },
  cached: { tokens: 500 },
  cacheCreate: { tokens: 0 },
  output: { tokens: 250 },
  reasoning: { tokens: 250 },
} as const;

describe("formatTokens", () => {
  test("formats small numbers as-is with locale formatting", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(999)).toBe("999");
  });

  test("formats thousands with k suffix", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(58507)).toBe("58.5k");
    expect(formatTokens(999_999)).toBe("1000.0k");
  });

  test("formats millions with M suffix", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(58_507_900)).toBe("58.5M");
    expect(formatTokens(4_133_000)).toBe("4.1M");
  });
});

describe("calculateTokenMeterData", () => {
  const providerConfigWithOverride: ProvidersConfigMap = {
    anthropic: {
      apiKeySet: false,
      isEnabled: true,
      isConfigured: true,
      models: [{ id: "claude-sonnet-4-0", contextWindowTokens: 100_000 }],
    },
  };

  test("uses custom context override for unknown models", () => {
    const result = calculateTokenMeterData(
      SAMPLE_USAGE,
      "anthropic:claude-sonnet-4-0",
      false,
      false,
      providerConfigWithOverride
    );

    expect(result.maxTokens).toBe(100_000);
    expect(result.totalTokens).toBe(11_000);
    expect(result.totalPercentage).toBeCloseTo(11);
  });

  test("keeps unknown models relative when no override is configured", () => {
    const result = calculateTokenMeterData(SAMPLE_USAGE, "anthropic:claude-sonnet-4-0", false);

    expect(result.maxTokens).toBeUndefined();
    expect(result.totalTokens).toBe(11_000);
  });

  test("1M toggle overrides custom context limit for supported Anthropic models", () => {
    const result = calculateTokenMeterData(
      SAMPLE_USAGE,
      "anthropic:claude-sonnet-4-0",
      true,
      false,
      providerConfigWithOverride
    );

    expect(result.maxTokens).toBe(1_000_000);
    expect(result.totalPercentage).toBeCloseTo(1.1);
  });
});
