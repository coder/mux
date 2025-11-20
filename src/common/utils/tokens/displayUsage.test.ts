import { describe, test, expect } from "bun:test";
import { collectUsageHistory } from "./displayUsage";
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
