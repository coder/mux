import { describe, test, expect } from "bun:test";
import { createDisplayUsage } from "./displayUsage";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

describe("createDisplayUsage", () => {
  describe("AI SDK v6: unified cached token subtraction", () => {
    // AI SDK v6 changed semantics: ALL providers now report inputTokens INCLUSIVE
    // of cached tokens. We always subtract cachedInputTokens + cacheCreateTokens
    // to get the true non-cached input.

    test("subtracts cached tokens for OpenAI model", () => {
      const openAIUsage: LanguageModelV2Usage = {
        inputTokens: 108200, // Includes 71600 cached
        outputTokens: 227,
        totalTokens: 108427,
        cachedInputTokens: 71600,
      };

      const result = createDisplayUsage(openAIUsage, "openai:gpt-5.2");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(71600);
      // Input = raw minus cached: 108200 - 71600 = 36600
      expect(result!.input.tokens).toBe(36600);
    });

    test("subtracts cached tokens for gateway OpenAI model", () => {
      const openAIUsage: LanguageModelV2Usage = {
        inputTokens: 108200,
        outputTokens: 227,
        totalTokens: 108427,
        cachedInputTokens: 71600,
      };

      const result = createDisplayUsage(openAIUsage, "mux-gateway:openai/gpt-5.2");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(71600);
      // Input = raw minus cached: 108200 - 71600 = 36600
      expect(result!.input.tokens).toBe(36600);
    });

    test("subtracts cached tokens for Anthropic model (v6 semantics)", () => {
      // In v6, Anthropic now reports inputTokens INCLUSIVE of cached tokens
      // (matching OpenAI/Google behavior). inputTokens = input + cache_read + cache_write.
      const anthropicUsage: LanguageModelV2Usage = {
        inputTokens: 108200, // 36600 non-cached + 71600 cache_read
        outputTokens: 227,
        totalTokens: 108427,
        cachedInputTokens: 71600,
      };

      const result = createDisplayUsage(anthropicUsage, "anthropic:claude-opus-4-6");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(71600);
      // Input = raw minus cached: 108200 - 71600 = 36600 (non-cached only)
      expect(result!.input.tokens).toBe(36600);
    });

    test("subtracts cached tokens for gateway Anthropic model", () => {
      const anthropicUsage: LanguageModelV2Usage = {
        inputTokens: 108200,
        outputTokens: 227,
        totalTokens: 108427,
        cachedInputTokens: 71600,
      };

      const result = createDisplayUsage(anthropicUsage, "mux-gateway:anthropic/claude-opus-4-6");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(71600);
      // Input = raw minus cached: 108200 - 71600 = 36600
      expect(result!.input.tokens).toBe(36600);
    });

    test("subtracts both cached and cache-create for Anthropic with cache creation", () => {
      // Anthropic with both cache_read and cache_creation tokens
      // inputTokens = 500 non-cached + 100000 cache_read + 5000 cache_write = 105500
      const usage: LanguageModelV2Usage = {
        inputTokens: 105500,
        outputTokens: 1000,
        totalTokens: 106500,
        cachedInputTokens: 100000,
      };

      const result = createDisplayUsage(usage, "anthropic:claude-opus-4-6", {
        anthropic: { cacheCreationInputTokens: 5000 },
      });

      expect(result).toBeDefined();
      expect(result!.input.tokens).toBe(500); // 105500 - 100000 - 5000
      expect(result!.cached.tokens).toBe(100000);
      expect(result!.cacheCreate.tokens).toBe(5000);
      expect(result!.output.tokens).toBe(1000);

      // Total should match actual context (no double counting)
      const total =
        result!.input.tokens +
        result!.cached.tokens +
        result!.cacheCreate.tokens +
        result!.output.tokens;
      expect(total).toBe(106500);
    });

    test("subtracts cached tokens for Google model", () => {
      const googleUsage: LanguageModelV2Usage = {
        inputTokens: 74300, // Includes 42600 cached
        outputTokens: 1600,
        totalTokens: 75900,
        cachedInputTokens: 42600,
      };

      const result = createDisplayUsage(googleUsage, "google:gemini-3-pro-preview");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(42600);
      // Input = raw minus cached: 74300 - 42600 = 31700
      expect(result!.input.tokens).toBe(31700);
    });

    test("subtracts cached tokens for gateway Google model", () => {
      const googleUsage: LanguageModelV2Usage = {
        inputTokens: 74300,
        outputTokens: 1600,
        totalTokens: 75900,
        cachedInputTokens: 42600,
      };

      const result = createDisplayUsage(googleUsage, "mux-gateway:google/gemini-3-pro-preview");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(42600);
      // Input = raw minus cached: 74300 - 42600 = 31700
      expect(result!.input.tokens).toBe(31700);
    });
  });

  describe("backward compatibility with pre-v6 data", () => {
    test("clamps to 0 when pre-v6 Anthropic data has inputTokens excluding cache", () => {
      // Pre-v6 historical data: inputTokens excluded cache, so subtracting
      // would go negative. Math.max(0, ...) ensures no negative values.
      const oldFormatUsage: LanguageModelV2Usage = {
        inputTokens: 500, // Pre-v6: non-cached only
        outputTokens: 227,
        totalTokens: 72327,
        cachedInputTokens: 71600,
      };

      const result = createDisplayUsage(oldFormatUsage, "anthropic:claude-sonnet-4-5");

      expect(result).toBeDefined();
      // Input clamps to 0 (500 - 71600 would be negative)
      expect(result!.input.tokens).toBe(0);
      expect(result!.cached.tokens).toBe(71600);
      // Total is approximately correct (off by 500 non-cached, acceptable for old data)
    });
  });

  test("returns undefined for undefined usage", () => {
    expect(createDisplayUsage(undefined, "openai:gpt-5.2")).toBeUndefined();
  });

  test("handles zero cached tokens", () => {
    const usage: LanguageModelV2Usage = {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      cachedInputTokens: 0,
    };

    const result = createDisplayUsage(usage, "openai:gpt-5.2");

    expect(result).toBeDefined();
    expect(result!.input.tokens).toBe(1000);
    expect(result!.cached.tokens).toBe(0);
  });

  test("handles missing cachedInputTokens field", () => {
    const usage: LanguageModelV2Usage = {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
    };

    const result = createDisplayUsage(usage, "openai:gpt-5.2");

    expect(result).toBeDefined();
    expect(result!.input.tokens).toBe(1000);
    expect(result!.cached.tokens).toBe(0);
  });

  describe("Subscription-covered usage costs", () => {
    test("returns $0 costs when providerMetadata.mux.costsIncluded is true", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 1000, // OpenAI includes cached tokens
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      };

      const result = createDisplayUsage(usage, "openai:gpt-5.2", {
        mux: { costsIncluded: true },
      });

      expect(result).toBeDefined();
      // Token handling remains unchanged
      expect(result!.input.tokens).toBe(800);
      expect(result!.cached.tokens).toBe(200);

      expect(result!.input.cost_usd).toBe(0);
      expect(result!.cached.cost_usd).toBe(0);
      expect(result!.cacheCreate.cost_usd).toBe(0);
      expect(result!.output.cost_usd).toBe(0);
      expect(result!.reasoning.cost_usd).toBe(0);
    });

    test("returns $0 costs even when model pricing is unknown", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      };

      const result = createDisplayUsage(usage, "openai:some-unknown-model", {
        mux: { costsIncluded: true },
      });

      expect(result).toBeDefined();
      expect(result!.input.cost_usd).toBe(0);
      expect(result!.cached.cost_usd).toBe(0);
      expect(result!.cacheCreate.cost_usd).toBe(0);
      expect(result!.output.cost_usd).toBe(0);
      expect(result!.reasoning.cost_usd).toBe(0);
    });
  });
  describe("Anthropic cache creation tokens from providerMetadata", () => {
    // Cache creation tokens are Anthropic-specific and only available in
    // providerMetadata.anthropic.cacheCreationInputTokens, not in LanguageModelV2Usage.
    // This is critical for liveUsage display during streaming.

    test("extracts cacheCreationInputTokens from providerMetadata", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
      };

      const result = createDisplayUsage(usage, "anthropic:claude-sonnet-4-20250514", {
        anthropic: { cacheCreationInputTokens: 800 },
      });

      expect(result).toBeDefined();
      expect(result!.cacheCreate.tokens).toBe(800);
    });

    test("cacheCreate is 0 when providerMetadata is undefined", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
      };

      const result = createDisplayUsage(usage, "anthropic:claude-sonnet-4-20250514");

      expect(result).toBeDefined();
      expect(result!.cacheCreate.tokens).toBe(0);
    });

    test("cacheCreate is 0 when anthropic metadata lacks cacheCreationInputTokens", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
      };

      const result = createDisplayUsage(usage, "anthropic:claude-sonnet-4-20250514", {
        anthropic: { someOtherField: 123 },
      });

      expect(result).toBeDefined();
      expect(result!.cacheCreate.tokens).toBe(0);
    });

    test("handles gateway Anthropic model with cache creation", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 2000,
        outputTokens: 100,
        totalTokens: 2100,
      };

      const result = createDisplayUsage(usage, "mux-gateway:anthropic/claude-sonnet-4-5", {
        anthropic: { cacheCreationInputTokens: 1500 },
      });

      expect(result).toBeDefined();
      expect(result!.cacheCreate.tokens).toBe(1500);
    });
  });
});
