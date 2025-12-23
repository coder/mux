/**
 * Tests for provider options builder
 */

import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import { describe, test, expect, mock } from "bun:test";
import { buildProviderOptions } from "./providerOptions";

// Mock the log module to avoid console noise
void mock.module("@/node/services/log", () => ({
  log: {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
  },
}));

describe("buildProviderOptions - Anthropic", () => {
  describe("Opus 4.5 (effort parameter)", () => {
    test("should use effort and thinking parameters for claude-opus-4-5", () => {
      const result = buildProviderOptions("anthropic:claude-opus-4-5", "medium");

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
          thinking: {
            type: "enabled",
            budgetTokens: 10000, // ANTHROPIC_THINKING_BUDGETS.medium
          },
          effort: "medium",
        },
      });
    });

    test("should use effort and thinking parameters for claude-opus-4-5-20251101", () => {
      const result = buildProviderOptions("anthropic:claude-opus-4-5-20251101", "high");

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
          thinking: {
            type: "enabled",
            budgetTokens: 20000, // ANTHROPIC_THINKING_BUDGETS.high
          },
          effort: "high",
        },
      });
    });

    test("should use effort 'low' with no thinking when off for Opus 4.5", () => {
      const result = buildProviderOptions("anthropic:claude-opus-4-5", "off");

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
          effort: "low", // "off" maps to effort: "low" for efficiency
        },
      });
    });
  });

  describe("Other Anthropic models (thinking/budgetTokens)", () => {
    test("should use thinking.budgetTokens for claude-sonnet-4-5", () => {
      const result = buildProviderOptions("anthropic:claude-sonnet-4-5", "medium");

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
          thinking: {
            type: "enabled",
            budgetTokens: 10000,
          },
        },
      });
    });

    test("should use thinking.budgetTokens for claude-opus-4-1", () => {
      const result = buildProviderOptions("anthropic:claude-opus-4-1", "high");

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
          thinking: {
            type: "enabled",
            budgetTokens: 20000,
          },
        },
      });
    });

    test("should use thinking.budgetTokens for claude-haiku-4-5", () => {
      const result = buildProviderOptions("anthropic:claude-haiku-4-5", "low");

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
          thinking: {
            type: "enabled",
            budgetTokens: 4000,
          },
        },
      });
    });

    test("should omit thinking when thinking is off for non-Opus 4.5", () => {
      const result = buildProviderOptions("anthropic:claude-sonnet-4-5", "off");

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
        },
      });
    });
  });
});

describe("buildProviderOptions - OpenAI", () => {
  // Helper to extract OpenAI options from the result
  const getOpenAIOptions = (
    result: ReturnType<typeof buildProviderOptions>
  ): OpenAIResponsesProviderOptions | undefined => {
    if ("openai" in result) {
      return result.openai;
    }
    return undefined;
  };

  describe("promptCacheKey derivation", () => {
    test("should derive promptCacheKey from workspaceId when provided", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        undefined,
        "abc123"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.promptCacheKey).toBe("mux-v1-abc123");
      expect(openai!.truncation).toBe("disabled");
    });

    test("should derive promptCacheKey for gateway OpenAI model", () => {
      const result = buildProviderOptions(
        "mux-gateway:openai/gpt-5.2",
        "off",
        undefined,
        undefined,
        undefined,
        "workspace-xyz"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.promptCacheKey).toBe("mux-v1-workspace-xyz");
      expect(openai!.truncation).toBe("disabled");
    });
  });
});
