import { describe, expect, test } from "bun:test";
import { applyCacheControl } from "./cacheStrategy";
import type { ModelMessage } from "ai";

describe("applyCacheControl", () => {
  test("should not apply cache control for non-Anthropic models", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];

    const result = applyCacheControl(messages, "openai:gpt-5");
    expect(result).toEqual(messages);
  });

  test("should not apply cache control with less than 2 messages", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Hello" }];

    const result = applyCacheControl(messages, "anthropic:claude-sonnet-4-5");
    expect(result).toEqual(messages);
  });

  test("should apply single cache breakpoint for short conversation", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "What is the capital of France? ".repeat(200) }, // ~6400 chars > 1024 tokens
      { role: "assistant", content: "Paris is the capital. ".repeat(100) },
      { role: "user", content: "What about Germany?" },
    ];

    const result = applyCacheControl(messages, "anthropic:claude-sonnet-4-5");

    // With the improved strategy, should cache at index 1 (second-to-last message)
    // First message may also be cached if it has enough content
    const hasCaching = result.some((msg) => msg.providerOptions?.anthropic?.cacheControl);
    expect(hasCaching).toBe(true);

    // The last message (current user input) should never be cached
    expect(result[2].providerOptions?.anthropic?.cacheControl).toBeUndefined();
  });

  test("should cache system message with 1h TTL", () => {
    const largeSystemPrompt = "You are a helpful assistant. ".repeat(200); // ~6000 chars
    const messages: ModelMessage[] = [
      { role: "system", content: largeSystemPrompt },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "How are you?" },
    ];

    const result = applyCacheControl(messages, "anthropic:claude-sonnet-4-5");

    // System message should be cached with 1h TTL
    expect(result[0].providerOptions?.anthropic?.cacheControl).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    // Should also cache before last message with 5m TTL
    expect(result[2].providerOptions?.anthropic?.cacheControl).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
  });

  test("should apply multiple breakpoints for long conversation", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System instructions. ".repeat(200) }, // Large system
      { role: "user", content: "Question 1 ".repeat(100) },
      { role: "assistant", content: "Answer 1 ".repeat(100) },
      { role: "user", content: "Question 2 ".repeat(100) },
      { role: "assistant", content: "Answer 2 ".repeat(100) },
      { role: "user", content: "Question 3 ".repeat(100) },
      { role: "assistant", content: "Answer 3 ".repeat(100) },
      { role: "user", content: "Question 4 ".repeat(100) },
      { role: "assistant", content: "Answer 4 ".repeat(100) },
      { role: "user", content: "Question 5" },
    ];

    const result = applyCacheControl(messages, "anthropic:claude-sonnet-4-5");

    // Count breakpoints
    const breakpointIndices = result
      .map((msg, idx) => (msg.providerOptions?.anthropic?.cacheControl ? idx : -1))
      .filter((idx) => idx >= 0);

    // Should have multiple breakpoints (max 4)
    expect(breakpointIndices.length).toBeGreaterThan(1);
    expect(breakpointIndices.length).toBeLessThanOrEqual(4);

    // System message should have 1h TTL
    const systemCacheControl = result[0].providerOptions?.anthropic?.cacheControl;
    if (
      systemCacheControl &&
      typeof systemCacheControl === "object" &&
      "ttl" in systemCacheControl
    ) {
      expect(systemCacheControl.ttl).toBe("1h");
    }

    // Last cached message should have 5m TTL
    const lastCachedIdx = breakpointIndices[breakpointIndices.length - 1];
    const lastCacheControl = result[lastCachedIdx].providerOptions?.anthropic?.cacheControl;
    if (lastCacheControl && typeof lastCacheControl === "object" && "ttl" in lastCacheControl) {
      expect(lastCacheControl.ttl).toBe("5m");
    }
  });

  test("should respect Haiku minimum token requirement (2048)", () => {
    // Small messages that don't meet Haiku threshold
    const messages: ModelMessage[] = [
      { role: "user", content: "Short question" }, // ~60 chars < 2048 tokens
      { role: "assistant", content: "Short answer" },
      { role: "user", content: "Another question" },
    ];

    const result = applyCacheControl(messages, "anthropic:claude-haiku-3-5");

    // Should not apply caching for Haiku with small content
    const hasCaching = result.some((msg) => msg.providerOptions?.anthropic?.cacheControl);
    expect(hasCaching).toBe(false);
  });

  test("should apply caching for Haiku with sufficient content", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Long message ".repeat(400) }, // ~5200 chars > 2048 tokens
      { role: "assistant", content: "Response ".repeat(400) },
      { role: "user", content: "Follow up" },
    ];

    const result = applyCacheControl(messages, "anthropic:claude-haiku-3-5");

    // Should cache with Haiku when content is large enough
    const hasCaching = result.some((msg) => msg.providerOptions?.anthropic?.cacheControl);
    expect(hasCaching).toBe(true);
  });

  test("should handle messages with array content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Here is a long document. ".repeat(200) },
          { type: "text", text: "Additional context. ".repeat(100) },
        ],
      },
      { role: "assistant", content: "I understand" },
      { role: "user", content: "What did I say?" },
    ];

    const result = applyCacheControl(messages, "anthropic:claude-sonnet-4-5");

    // Should handle multi-part content and apply caching
    expect(result[1].providerOptions?.anthropic?.cacheControl).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
  });

  test("should preserve existing providerOptions", () => {
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: "System prompt with detailed instructions. ".repeat(300), // ~12600 chars > 1024 tokens
        providerOptions: {
          anthropic: {
            customOption: "value",
          },
        },
      },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "Continue" },
    ];

    const result = applyCacheControl(messages, "anthropic:claude-sonnet-4-5");

    // Should preserve existing options while adding cacheControl
    const anthropicOptions = result[0].providerOptions?.anthropic as Record<string, unknown>;
    expect(anthropicOptions?.customOption).toBe("value");
    expect(anthropicOptions?.cacheControl).toBeDefined();
  });

  test("should not exceed 4 breakpoint limit", () => {
    // Create a very long conversation
    const messages: ModelMessage[] = [{ role: "system", content: "System ".repeat(300) }];

    // Add 20 message pairs
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "user", content: `User message ${i} `.repeat(100) });
      messages.push({ role: "assistant", content: `Assistant ${i} `.repeat(100) });
    }

    const result = applyCacheControl(messages, "anthropic:claude-sonnet-4-5");

    // Count breakpoints
    const breakpointCount = result.filter(
      (msg) => msg.providerOptions?.anthropic?.cacheControl
    ).length;

    // Should never exceed 4 breakpoints
    expect(breakpointCount).toBeLessThanOrEqual(4);
    expect(breakpointCount).toBeGreaterThan(0);
  });

  test("should place 1h TTL before 5m TTL", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System instructions. ".repeat(200) },
      { role: "user", content: "Q1 ".repeat(100) },
      { role: "assistant", content: "A1 ".repeat(100) },
      { role: "user", content: "Q2 ".repeat(100) },
      { role: "assistant", content: "A2 ".repeat(100) },
      { role: "user", content: "Q3" },
    ];

    const result = applyCacheControl(messages, "anthropic:claude-sonnet-4-5");

    // Collect breakpoints with their TTLs
    const breakpoints = result
      .map((msg, idx) => {
        const cacheControl = msg.providerOptions?.anthropic?.cacheControl;
        const ttl =
          cacheControl && typeof cacheControl === "object" && "ttl" in cacheControl
            ? (cacheControl.ttl as "5m" | "1h" | undefined)
            : undefined;
        return { idx, ttl };
      })
      .filter((bp): bp is { idx: number; ttl: "5m" | "1h" } => bp.ttl !== undefined);

    // Find first 1h and first 5m
    const firstOneHour = breakpoints.find((bp) => bp.ttl === "1h");
    const firstFiveMin = breakpoints.find((bp) => bp.ttl === "5m");

    // If both exist, 1h should come before 5m
    if (firstOneHour && firstFiveMin) {
      expect(firstOneHour.idx).toBeLessThan(firstFiveMin.idx);
    }
  });

  test("should handle image content in token estimation", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Analyze this image: ".repeat(100) },
          { type: "image", image: "data:image/png;base64,..." },
        ],
      },
      { role: "assistant", content: "I see a test image" },
      { role: "user", content: "What else?" },
    ];

    const result = applyCacheControl(messages, "anthropic:claude-sonnet-4-5");

    // Should account for image tokens and apply caching
    const hasCaching = result.some((msg) => msg.providerOptions?.anthropic?.cacheControl);
    expect(hasCaching).toBe(true);
  });

  test("should handle edge case with exact minimum tokens", () => {
    // Create content that's exactly at the threshold (1024 tokens ≈ 4096 chars)
    const messages: ModelMessage[] = [
      { role: "user", content: "x".repeat(4096) },
      { role: "assistant", content: "ok" },
      { role: "user", content: "continue" },
    ];

    const result = applyCacheControl(messages, "anthropic:claude-sonnet-4-5");

    // Should apply caching at the threshold
    const hasCaching = result.some((msg) => msg.providerOptions?.anthropic?.cacheControl);
    expect(hasCaching).toBe(true);
  });
});
