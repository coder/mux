import { describe, expect, it } from "bun:test";
import {
  isV3Usage,
  flatUsageToV3,
  normalizeFinishReason,
  normalizeGatewayGenerateResult,
  normalizeGatewayStreamUsage,
  type V3Usage,
} from "./gatewayStreamNormalization";

describe("isV3Usage", () => {
  it("returns true for v3 nested usage", () => {
    expect(
      isV3Usage({
        inputTokens: { total: 100 },
        outputTokens: { total: 50 },
      })
    ).toBe(true);
  });

  it("returns false for flat v2 usage", () => {
    expect(isV3Usage({ inputTokens: 100, outputTokens: 50 })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isV3Usage(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isV3Usage(undefined)).toBe(false);
  });

  it("returns false for non-object", () => {
    expect(isV3Usage("string")).toBe(false);
    expect(isV3Usage(42)).toBe(false);
  });
});

describe("flatUsageToV3", () => {
  it("converts basic flat usage to v3 nested format", () => {
    const result = flatUsageToV3({
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(result.inputTokens.total).toBe(1000);
    expect(result.outputTokens.total).toBe(500);
    expect(result.raw).toEqual({ inputTokens: 1000, outputTokens: 500 });
  });

  it("handles cached input tokens", () => {
    const result = flatUsageToV3({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 300,
    });

    expect(result.inputTokens.total).toBe(1000);
    expect(result.inputTokens.cacheRead).toBe(300);
    expect(result.inputTokens.noCache).toBe(700); // 1000 - 300
  });

  it("handles reasoning tokens", () => {
    const result = flatUsageToV3({
      inputTokens: 1000,
      outputTokens: 500,
      reasoningTokens: 200,
    });

    expect(result.outputTokens.total).toBe(500);
    expect(result.outputTokens.reasoning).toBe(200);
    expect(result.outputTokens.text).toBe(300); // 500 - 200
  });

  it("handles all token types together", () => {
    const result = flatUsageToV3({
      inputTokens: 2000,
      outputTokens: 800,
      cachedInputTokens: 500,
      reasoningTokens: 100,
    });

    expect(result.inputTokens.total).toBe(2000);
    expect(result.inputTokens.noCache).toBe(1500);
    expect(result.inputTokens.cacheRead).toBe(500);
    expect(result.outputTokens.total).toBe(800);
    expect(result.outputTokens.text).toBe(700);
    expect(result.outputTokens.reasoning).toBe(100);
  });

  it("handles missing fields gracefully", () => {
    const result = flatUsageToV3({});

    expect(result.inputTokens.total).toBeUndefined();
    expect(result.inputTokens.noCache).toBeUndefined();
    expect(result.outputTokens.total).toBeUndefined();
    expect(result.outputTokens.text).toBeUndefined();
  });

  it("preserves raw original usage", () => {
    const original = { inputTokens: 42, outputTokens: 17, totalTokens: 59 };
    const result = flatUsageToV3(original);
    expect(result.raw).toEqual(original);
  });
});

describe("normalizeFinishReason", () => {
  it("returns undefined for null/undefined", () => {
    expect(normalizeFinishReason(null)).toBeUndefined();
    expect(normalizeFinishReason(undefined)).toBeUndefined();
  });

  it("passes through v3 format unchanged", () => {
    const v3 = { unified: "stop", raw: "stop" };
    expect(normalizeFinishReason(v3)).toBe(v3);
  });

  it("converts plain string to v3 format", () => {
    expect(normalizeFinishReason("stop")).toEqual({ unified: "stop", raw: "stop" });
    expect(normalizeFinishReason("length")).toEqual({ unified: "length", raw: "length" });
    expect(normalizeFinishReason("tool-calls")).toEqual({
      unified: "tool-calls",
      raw: "tool-calls",
    });
  });

  it('converts "unknown" to "other"', () => {
    expect(normalizeFinishReason("unknown")).toEqual({ unified: "other", raw: "unknown" });
  });

  it("handles non-string non-object as 'other'", () => {
    expect(normalizeFinishReason(42)).toEqual({ unified: "other", raw: "other" });
  });
});

describe("normalizeGatewayGenerateResult", () => {
  it("converts flat usage in generate result", () => {
    const result = normalizeGatewayGenerateResult({
      content: [{ type: "text", text: "hello" }],
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      finishReason: "stop",
    });

    // Usage should be v3 nested
    const usage = result.usage as V3Usage;
    expect(usage.inputTokens.total).toBe(100);
    expect(usage.outputTokens.total).toBe(50);

    // finishReason should be v3 object (cast because generic return type
    // preserves the input shape, but the value is actually transformed)
    expect(result.finishReason as unknown).toEqual({ unified: "stop", raw: "stop" });
  });

  it("preserves already-v3 usage", () => {
    const v3Usage: V3Usage = {
      inputTokens: { total: 100, noCache: 80, cacheRead: 20, cacheWrite: undefined },
      outputTokens: { total: 50, text: 40, reasoning: 10 },
    };
    const result = normalizeGatewayGenerateResult({
      usage: v3Usage,
      finishReason: { unified: "stop", raw: "stop" },
    });

    // Should not be modified
    expect(result.usage).toBe(v3Usage);
  });

  it("preserves other result fields", () => {
    const result = normalizeGatewayGenerateResult({
      content: [{ type: "text", text: "hello" }],
      usage: { inputTokens: 10, outputTokens: 5 },
      providerMetadata: { openai: { foo: "bar" } },
    });

    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.providerMetadata).toEqual({ openai: { foo: "bar" } });
  });
});

describe("normalizeGatewayStreamUsage", () => {
  async function collectStream(chunks: unknown[]): Promise<unknown[]> {
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    const result: unknown[] = [];
    const transformed: ReadableStream<unknown> = stream.pipeThrough(normalizeGatewayStreamUsage());
    const reader = transformed.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      result.push(chunk.value);
    }
    return result;
  }

  it("passes non-finish events through unchanged", async () => {
    const chunks = [
      { type: "text-delta", text: "hello" },
      { type: "reasoning-delta", text: "thinking" },
      { type: "tool-input-start", toolName: "bash" },
    ];

    const result = await collectStream(chunks);
    expect(result).toEqual(chunks);
  });

  it("converts flat usage in finish events to v3 format", async () => {
    const chunks = [
      { type: "text-delta", text: "hello" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      },
    ];

    const result = await collectStream(chunks);

    // First chunk unchanged
    expect(result[0]).toEqual({ type: "text-delta", text: "hello" });

    // Finish chunk should have v3 usage
    const finish = result[1] as Record<string, unknown>;
    expect(finish.type).toBe("finish");

    const usage = finish.usage as V3Usage;
    expect(usage.inputTokens.total).toBe(1000);
    expect(usage.outputTokens.total).toBe(500);

    // finishReason should be v3 object
    expect(finish.finishReason).toEqual({ unified: "stop", raw: "stop" });
  });

  it("preserves already-v3 finish events", async () => {
    const v3Finish = {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 100, noCache: 80, cacheRead: 20, cacheWrite: undefined },
        outputTokens: { total: 50, text: 40, reasoning: 10 },
      },
    };

    const result = await collectStream([v3Finish]);
    const finish = result[0] as Record<string, unknown>;
    // Usage should be the same v3 object (not re-wrapped)
    expect(finish.usage).toBe(v3Finish.usage);
  });

  it("handles null/undefined values gracefully", async () => {
    const result = await collectStream([null, undefined, "string", 42]);
    // Non-objects pass through
    expect(result).toEqual([null, undefined, "string", 42]);
  });

  it("handles finish events with no usage", async () => {
    const chunks = [{ type: "finish", finishReason: "stop" }];
    const result = await collectStream(chunks);
    const finish = result[0] as Record<string, unknown>;
    expect(finish.type).toBe("finish");
    // No usage field, just finishReason normalized
    expect(finish.finishReason).toEqual({ unified: "stop", raw: "stop" });
  });

  it("handles finish with cached and reasoning tokens", async () => {
    const chunks = [
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: 2000,
          outputTokens: 800,
          cachedInputTokens: 500,
          reasoningTokens: 200,
          totalTokens: 2800,
        },
      },
    ];

    const result = await collectStream(chunks);
    const finish = result[0] as Record<string, unknown>;
    const usage = finish.usage as V3Usage;

    expect(usage.inputTokens.total).toBe(2000);
    expect(usage.inputTokens.cacheRead).toBe(500);
    expect(usage.inputTokens.noCache).toBe(1500);
    expect(usage.outputTokens.total).toBe(800);
    expect(usage.outputTokens.reasoning).toBe(200);
    expect(usage.outputTokens.text).toBe(600);
  });
});
