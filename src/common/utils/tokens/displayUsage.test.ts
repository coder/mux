import { describe, test, expect } from "bun:test";
import { createDisplayUsage } from "./displayUsage";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

describe("createDisplayUsage", () => {
  describe("Provider-specific cached token handling", () => {
    // OpenAI reports inputTokens INCLUSIVE of cachedInputTokens
    // We must subtract cached from input to avoid double-counting
    const openAIUsage: LanguageModelV2Usage = {
      inputTokens: 108200, // Includes 71600 cached
      outputTokens: 227,
      totalTokens: 108427,
      cachedInputTokens: 71600,
    };

    test("subtracts cached tokens for direct OpenAI model", () => {
      const result = createDisplayUsage(openAIUsage, "openai:gpt-5.2");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(71600);
      // Input should be raw minus cached: 108200 - 71600 = 36600
      expect(result!.input.tokens).toBe(36600);
    });

    test("subtracts cached tokens for gateway OpenAI model", () => {
      // Gateway format: mux-gateway:openai/model-name
      const result = createDisplayUsage(openAIUsage, "mux-gateway:openai/gpt-5.2");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(71600);
      // Should also subtract: 108200 - 71600 = 36600
      expect(result!.input.tokens).toBe(36600);
    });

    test("does NOT subtract cached tokens for Anthropic model", () => {
      // Anthropic reports inputTokens EXCLUDING cachedInputTokens
      const anthropicUsage: LanguageModelV2Usage = {
        inputTokens: 36600, // Already excludes cached
        outputTokens: 227,
        totalTokens: 108427,
        cachedInputTokens: 71600,
      };

      const result = createDisplayUsage(anthropicUsage, "anthropic:claude-sonnet-4-5");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(71600);
      // Input stays as-is for Anthropic
      expect(result!.input.tokens).toBe(36600);
    });

    test("does NOT subtract cached tokens for gateway Anthropic model", () => {
      const anthropicUsage: LanguageModelV2Usage = {
        inputTokens: 36600,
        outputTokens: 227,
        totalTokens: 108427,
        cachedInputTokens: 71600,
      };

      const result = createDisplayUsage(anthropicUsage, "mux-gateway:anthropic/claude-sonnet-4-5");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(71600);
      // Input stays as-is for gateway Anthropic
      expect(result!.input.tokens).toBe(36600);
    });

    test("subtracts cached tokens for direct Google model", () => {
      // Google also reports inputTokens INCLUSIVE of cachedInputTokens
      const googleUsage: LanguageModelV2Usage = {
        inputTokens: 74300, // Includes 42600 cached
        outputTokens: 1600,
        totalTokens: 75900,
        cachedInputTokens: 42600,
      };

      const result = createDisplayUsage(googleUsage, "google:gemini-3-pro-preview");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(42600);
      // Input should be raw minus cached: 74300 - 42600 = 31700
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
      // Should also subtract: 74300 - 42600 = 31700
      expect(result!.input.tokens).toBe(31700);
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

  describe("OpenAI service tier cost adjustments", () => {
    // gpt-5 has tier-specific pricing in models.json:
    // - standard: input $1.25/M, output $10/M
    // - flex: input $0.625/M, output $5/M (~50% cheaper)
    // - priority: input $2.50/M, output $20/M (~2x)
    const usage: LanguageModelV2Usage = {
      inputTokens: 1000000, // 1M tokens for easy math
      outputTokens: 100000, // 100K tokens
      totalTokens: 1100000,
    };

    test("applies standard pricing when serviceTier is undefined", () => {
      const result = createDisplayUsage(usage, "openai:gpt-5");

      expect(result).toBeDefined();
      // Standard: $1.25/M input = $1.25 for 1M tokens
      expect(result!.input.cost_usd).toBeCloseTo(1.25, 2);
      // Standard: $10/M output = $1.00 for 100K tokens
      expect(result!.output.cost_usd).toBeCloseTo(1.0, 2);
    });

    test("applies standard pricing when serviceTier is 'default'", () => {
      const result = createDisplayUsage(usage, "openai:gpt-5", {
        openai: { serviceTier: "default" },
      });

      expect(result).toBeDefined();
      expect(result!.input.cost_usd).toBeCloseTo(1.25, 2);
      expect(result!.output.cost_usd).toBeCloseTo(1.0, 2);
    });

    test("applies flex pricing when serviceTier is 'flex'", () => {
      const result = createDisplayUsage(usage, "openai:gpt-5", {
        openai: { serviceTier: "flex" },
      });

      expect(result).toBeDefined();
      // Flex: $0.625/M input = $0.625 for 1M tokens
      expect(result!.input.cost_usd).toBeCloseTo(0.625, 3);
      // Flex: $5/M output = $0.50 for 100K tokens
      expect(result!.output.cost_usd).toBeCloseTo(0.5, 2);
    });

    test("applies priority pricing when serviceTier is 'priority'", () => {
      const result = createDisplayUsage(usage, "openai:gpt-5", {
        openai: { serviceTier: "priority" },
      });

      expect(result).toBeDefined();
      // Priority: $2.50/M input = $2.50 for 1M tokens
      expect(result!.input.cost_usd).toBeCloseTo(2.5, 2);
      // Priority: $20/M output = $2.00 for 100K tokens
      expect(result!.output.cost_usd).toBeCloseTo(2.0, 2);
    });

    test("ignores serviceTier for non-OpenAI models", () => {
      // Even if serviceTier is present, non-OpenAI models should use standard pricing
      const result = createDisplayUsage(usage, "anthropic:claude-sonnet-4-5", {
        openai: { serviceTier: "flex" }, // Should be ignored
      });

      expect(result).toBeDefined();
      // Anthropic pricing shouldn't change based on OpenAI serviceTier
      // Just verify tokens are correct (pricing varies by model)
      expect(result!.input.tokens).toBe(1000000);
      expect(result!.output.tokens).toBe(100000);
    });

    test("applies flex pricing to cached tokens", () => {
      const usageWithCache: LanguageModelV2Usage = {
        inputTokens: 1000000, // Includes cached
        outputTokens: 100000,
        totalTokens: 1100000,
        cachedInputTokens: 500000, // 500K cached
      };

      const result = createDisplayUsage(usageWithCache, "openai:gpt-5", {
        openai: { serviceTier: "flex" },
      });

      expect(result).toBeDefined();
      // Flex cache: $0.0625/M = $0.03125 for 500K tokens
      expect(result!.cached.cost_usd).toBeCloseTo(0.03125, 4);
    });
  });
});
