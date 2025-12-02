import { describe, test, expect } from "bun:test";
import { collectUsageHistory, createDisplayUsage } from "./displayUsage";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { ChatUsageDisplay } from "./usageAggregator";

// Helper to create assistant message with usage
const createAssistant = (
  id: string,
  usage?: LanguageModelV2Usage,
  model?: string,
  historicalUsage?: ChatUsageDisplay
): MuxMessage => {
  const msg = createMuxMessage(id, "assistant", "Response", {
    historySequence: 0,
    usage,
    model,
    historicalUsage,
  });
  return msg;
};

describe("collectUsageHistory", () => {
  const basicUsage: LanguageModelV2Usage = {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
  };

  test("returns empty array for empty messages", () => {
    expect(collectUsageHistory([])).toEqual([]);
  });

  test("returns empty array when no assistant messages", () => {
    const userMsg = createMuxMessage("u1", "user", "Hello", { historySequence: 0 });
    expect(collectUsageHistory([userMsg])).toEqual([]);
  });

  test("extracts usage from single assistant message", () => {
    const msg = createAssistant("a1", basicUsage, "claude-sonnet-4-5");
    const result = collectUsageHistory([msg]);

    expect(result).toHaveLength(1);
    expect(result[0].model).toBe("claude-sonnet-4-5");
    expect(result[0].input.tokens).toBe(100);
    expect(result[0].output.tokens).toBe(50);
  });

  test("extracts usage from multiple assistant messages", () => {
    const msg1 = createAssistant("a1", basicUsage, "claude-sonnet-4-5");
    const msg2 = createAssistant("a2", { ...basicUsage, inputTokens: 200 }, "claude-sonnet-4-5");
    const result = collectUsageHistory([msg1, msg2]);

    expect(result).toHaveLength(2);
    expect(result[0].input.tokens).toBe(100);
    expect(result[1].input.tokens).toBe(200);
  });

  test("skips assistant messages without usage", () => {
    const msg1 = createAssistant("a1", basicUsage, "claude-sonnet-4-5");
    const msg2 = createAssistant("a2", undefined, "claude-sonnet-4-5"); // No usage
    const msg3 = createAssistant("a3", basicUsage, "claude-sonnet-4-5");
    const result = collectUsageHistory([msg1, msg2, msg3]);

    expect(result).toHaveLength(2); // msg2 excluded
  });

  test("filters out user messages", () => {
    const userMsg = createMuxMessage("u1", "user", "Hello", { historySequence: 0 });
    const assistantMsg = createAssistant("a1", basicUsage, "claude-sonnet-4-5");
    const result = collectUsageHistory([userMsg, assistantMsg]);

    expect(result).toHaveLength(1);
  });

  test("uses fallbackModel when message has no model", () => {
    const msg = createAssistant("a1", basicUsage, undefined);
    const result = collectUsageHistory([msg], "fallback-model");

    expect(result[0].model).toBe("fallback-model");
  });

  test("defaults to 'unknown' when no model provided", () => {
    const msg = createAssistant("a1", basicUsage, undefined);
    const result = collectUsageHistory([msg]);

    expect(result[0].model).toBe("unknown");
  });

  test("prepends historical usage from compaction summary", () => {
    const historicalUsage: ChatUsageDisplay = {
      input: { tokens: 500, cost_usd: 0.01 },
      output: { tokens: 250, cost_usd: 0.02 },
      cached: { tokens: 0 },
      cacheCreate: { tokens: 0 },
      reasoning: { tokens: 0 },
      model: "historical-model",
    };

    const msg = createAssistant("a1", basicUsage, "claude-sonnet-4-5", historicalUsage);
    const result = collectUsageHistory([msg]);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(historicalUsage); // Historical comes first
    expect(result[1].model).toBe("claude-sonnet-4-5"); // Current message second
  });

  test("uses latest historical usage when multiple messages have it", () => {
    const historical1: ChatUsageDisplay = {
      input: { tokens: 100 },
      output: { tokens: 50 },
      cached: { tokens: 0 },
      cacheCreate: { tokens: 0 },
      reasoning: { tokens: 0 },
      model: "first",
    };

    const historical2: ChatUsageDisplay = {
      input: { tokens: 200 },
      output: { tokens: 100 },
      cached: { tokens: 0 },
      cacheCreate: { tokens: 0 },
      reasoning: { tokens: 0 },
      model: "second",
    };

    const msg1 = createAssistant("a1", basicUsage, "model-1", historical1);
    const msg2 = createAssistant("a2", basicUsage, "model-2", historical2);
    const result = collectUsageHistory([msg1, msg2]);

    expect(result).toHaveLength(3); // historical2 + msg1 + msg2
    expect(result[0]).toBe(historical2); // Latest historical usage wins
    expect(result[0].model).toBe("second");
  });

  test("handles mixed message order correctly", () => {
    const userMsg = createMuxMessage("u1", "user", "Hello", { historySequence: 0 });
    const assistantMsg1 = createAssistant("a1", basicUsage, "model-1");
    const userMsg2 = createMuxMessage("u2", "user", "More", { historySequence: 2 });
    const assistantMsg2 = createAssistant("a2", basicUsage, "model-2");

    const result = collectUsageHistory([userMsg, assistantMsg1, userMsg2, assistantMsg2]);

    expect(result).toHaveLength(2);
    expect(result[0].model).toBe("model-1");
    expect(result[1].model).toBe("model-2");
  });
});

describe("createDisplayUsage", () => {
  describe("OpenAI cached token handling", () => {
    // OpenAI reports inputTokens INCLUSIVE of cachedInputTokens
    // We must subtract cached from input to avoid double-counting
    const openAIUsage: LanguageModelV2Usage = {
      inputTokens: 108200, // Includes 71600 cached
      outputTokens: 227,
      totalTokens: 108427,
      cachedInputTokens: 71600,
    };

    test("subtracts cached tokens for direct OpenAI model", () => {
      const result = createDisplayUsage(openAIUsage, "openai:gpt-5.1");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(71600);
      // Input should be raw minus cached: 108200 - 71600 = 36600
      expect(result!.input.tokens).toBe(36600);
    });

    test("subtracts cached tokens for gateway OpenAI model", () => {
      // Gateway format: mux-gateway:openai/model-name
      const result = createDisplayUsage(openAIUsage, "mux-gateway:openai/gpt-5.1");

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
  });

  test("returns undefined for undefined usage", () => {
    expect(createDisplayUsage(undefined, "openai:gpt-5.1")).toBeUndefined();
  });

  test("handles zero cached tokens", () => {
    const usage: LanguageModelV2Usage = {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      cachedInputTokens: 0,
    };

    const result = createDisplayUsage(usage, "openai:gpt-5.1");

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

    const result = createDisplayUsage(usage, "openai:gpt-5.1");

    expect(result).toBeDefined();
    expect(result!.input.tokens).toBe(1000);
    expect(result!.cached.tokens).toBe(0);
  });
});
