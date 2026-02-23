/**
 * Tests for provider options builder
 */

import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import { createMuxMessage } from "@/common/types/message";
import { describe, test, expect, mock } from "bun:test";
import {
  buildProviderOptions,
  buildRequestHeaders,
  ANTHROPIC_1M_CONTEXT_HEADER,
} from "./providerOptions";

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

  describe("Opus 4.6 (adaptive thinking + effort)", () => {
    test("should use adaptive thinking and effort for claude-opus-4-6", () => {
      const result = buildProviderOptions("anthropic:claude-opus-4-6", "medium");
      // SDK types don't include "adaptive" or "max" yet; verify runtime values
      const anthropic = (result as Record<string, unknown>).anthropic as Record<string, unknown>;

      expect(anthropic.disableParallelToolUse).toBe(false);
      expect(anthropic.sendReasoning).toBe(true);
      expect(anthropic.thinking).toEqual({ type: "adaptive" });
      expect(anthropic.effort).toBe("medium");
    });

    test("should map xhigh to max effort for Opus 4.6", () => {
      const result = buildProviderOptions("anthropic:claude-opus-4-6", "xhigh");
      const anthropic = (result as Record<string, unknown>).anthropic as Record<string, unknown>;

      expect(anthropic.thinking).toEqual({ type: "adaptive" });
      expect(anthropic.effort).toBe("max");
    });

    test("should use disabled thinking when off for Opus 4.6", () => {
      const result = buildProviderOptions("anthropic:claude-opus-4-6", "off");
      const anthropic = (result as Record<string, unknown>).anthropic as Record<string, unknown>;

      expect(anthropic.thinking).toEqual({ type: "disabled" });
      expect(anthropic.effort).toBe("low");
    });
  });

  describe("Sonnet 4.6 (adaptive thinking + effort)", () => {
    test("should use adaptive thinking and effort for claude-sonnet-4-6", () => {
      const result = buildProviderOptions("anthropic:claude-sonnet-4-6", "medium");
      const anthropic = (result as Record<string, unknown>).anthropic as Record<string, unknown>;

      expect(anthropic.disableParallelToolUse).toBe(false);
      expect(anthropic.sendReasoning).toBe(true);
      expect(anthropic.thinking).toEqual({ type: "adaptive" });
      expect(anthropic.effort).toBe("medium");
    });

    test("should map xhigh to max effort for Sonnet 4.6", () => {
      const result = buildProviderOptions("anthropic:claude-sonnet-4-6", "xhigh");
      const anthropic = (result as Record<string, unknown>).anthropic as Record<string, unknown>;

      expect(anthropic.thinking).toEqual({ type: "adaptive" });
      expect(anthropic.effort).toBe("max");
    });

    test("should use disabled thinking when off for Sonnet 4.6", () => {
      const result = buildProviderOptions("anthropic:claude-sonnet-4-6", "off");
      const anthropic = (result as Record<string, unknown>).anthropic as Record<string, unknown>;

      expect(anthropic.thinking).toEqual({ type: "disabled" });
      expect(anthropic.effort).toBe("low");
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

  describe("Anthropic cache TTL overrides", () => {
    test("should include cacheControl ttl when configured", () => {
      const result = buildProviderOptions(
        "anthropic:claude-sonnet-4-5",
        "off",
        undefined,
        undefined,
        {
          anthropic: { cacheTtl: "1h" },
        }
      );

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
          cacheControl: {
            type: "ephemeral",
            ttl: "1h",
          },
        },
      });
    });

    test("should include cacheControl ttl for Opus 4.6 effort models", () => {
      const result = buildProviderOptions(
        "anthropic:claude-opus-4-6",
        "medium",
        undefined,
        undefined,
        {
          anthropic: { cacheTtl: "5m" },
        }
      );

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
          thinking: {
            type: "adaptive",
          },
          cacheControl: {
            type: "ephemeral",
            ttl: "5m",
          },
          effort: "medium",
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

    test("should allow auto truncation when explicitly enabled", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        undefined,
        "compaction-workspace",
        "auto"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.truncation).toBe("auto");
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

  describe("reasoning summary compatibility", () => {
    test("should include reasoningSummary for supported OpenAI reasoning models", () => {
      const result = buildProviderOptions("openai:gpt-5.2", "medium");
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBe("medium");
      expect(openai!.reasoningSummary).toBe("detailed");
      expect(openai!.include).toEqual(["reasoning.encrypted_content"]);
    });

    test("should omit reasoningSummary for gpt-5.3-codex-spark", () => {
      const result = buildProviderOptions("openai:gpt-5.3-codex-spark", "medium");
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBe("medium");
      expect(openai!.reasoningSummary).toBeUndefined();
      expect(openai!.include).toEqual(["reasoning.encrypted_content"]);
    });
  });

  describe("previousResponseId reuse", () => {
    test("should reuse previousResponseId for gateway OpenAI history", () => {
      const messages = [
        createMuxMessage("assistant-1", "assistant", "", {
          model: "mux-gateway:openai/gpt-5.2",
          providerMetadata: { openai: { responseId: "resp_123" } },
        }),
      ];
      const result = buildProviderOptions("mux-gateway:openai/gpt-5.2", "medium", messages);
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.previousResponseId).toBe("resp_123");
    });
  });
});

describe("buildRequestHeaders", () => {
  test("should return anthropic-beta header for Opus 4.6 with use1MContext", () => {
    const result = buildRequestHeaders("anthropic:claude-opus-4-6", {
      anthropic: { use1MContext: true },
    });
    expect(result).toEqual({ "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER });
  });

  test("should return anthropic-beta header for gateway-routed Anthropic model", () => {
    const result = buildRequestHeaders("mux-gateway:anthropic/claude-opus-4-6", {
      anthropic: { use1MContext: true },
    });
    expect(result).toEqual({ "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER });
  });

  test("should return undefined for non-Anthropic model", () => {
    const result = buildRequestHeaders("openai:gpt-5.2", {
      anthropic: { use1MContext: true },
    });
    expect(result).toBeUndefined();
  });

  test("should return undefined when use1MContext is false", () => {
    const result = buildRequestHeaders("anthropic:claude-opus-4-6", {
      anthropic: { use1MContext: false },
    });
    expect(result).toBeUndefined();
  });

  test("should return undefined when no muxProviderOptions provided", () => {
    const result = buildRequestHeaders("anthropic:claude-opus-4-6");
    expect(result).toBeUndefined();
  });

  test("should return undefined for unsupported model even with use1MContext", () => {
    // claude-opus-4-1 doesn't support 1M context
    const result = buildRequestHeaders("anthropic:claude-opus-4-1", {
      anthropic: { use1MContext: true },
    });
    expect(result).toBeUndefined();
  });

  test("should return header when model is in use1MContextModels list", () => {
    const result = buildRequestHeaders("anthropic:claude-opus-4-6", {
      anthropic: { use1MContextModels: ["anthropic:claude-opus-4-6"] },
    });
    expect(result).toEqual({ "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER });
  });
});
