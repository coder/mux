import { describe, expect, test } from "bun:test";
import { MuxMessageSchema } from "./message";

function createMessage() {
  return {
    id: "msg-1",
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: "Hello" }],
  };
}

describe("MuxMessageSchema compactionEpoch parsing", () => {
  test("preserves valid positive integer compactionEpoch", () => {
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      metadata: {
        compactionEpoch: 7,
      },
    });

    expect(parsed.metadata?.compactionEpoch).toBe(7);
  });

  test("preserves acpPromptId metadata", () => {
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      metadata: {
        acpPromptId: "acp-prompt-123",
      },
    });

    expect(parsed.metadata?.acpPromptId).toBe("acp-prompt-123");
  });

  test("preserves routeProvider metadata", () => {
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      metadata: {
        routeProvider: "openai",
      },
    });

    expect(parsed.metadata?.routeProvider).toBe("openai");
  });

  test("preserves modelFallback metadata", () => {
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      metadata: {
        modelFallback: {
          requestedModel: "openai:gpt-5.5",
          refusedModels: ["openai:gpt-5.5", "google:gemini-3.1-pro-preview"],
        },
      },
    });

    expect(parsed.metadata?.modelFallback).toEqual({
      requestedModel: "openai:gpt-5.5",
      refusedModels: ["openai:gpt-5.5", "google:gemini-3.1-pro-preview"],
    });
  });

  test("tolerates malformed modelFallback values by treating them as absent", () => {
    const malformedModelFallbackValues: unknown[] = [
      null,
      "openai:gpt-5.5",
      7,
      [],
      {},
      { requestedModel: "openai:gpt-5.5" }, // missing refusedModels
      { refusedModels: ["openai:gpt-5.5"] }, // missing requestedModel
      { requestedModel: "openai:gpt-5.5", refusedModels: [7] }, // wrong element type
      { requestedModel: 7, refusedModels: ["openai:gpt-5.5"] },
    ];

    for (const malformedModelFallback of malformedModelFallbackValues) {
      const parsed = MuxMessageSchema.parse({
        ...createMessage(),
        metadata: {
          modelFallback: malformedModelFallback,
        },
      });

      expect(parsed.metadata?.modelFallback).toBeUndefined();
    }
  });

  test("tolerates malformed compactionEpoch values by treating them as absent", () => {
    const malformedCompactionEpochValues: unknown[] = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "7",
      null,
      true,
      {},
      [],
    ];

    for (const malformedCompactionEpoch of malformedCompactionEpochValues) {
      const parsed = MuxMessageSchema.parse({
        ...createMessage(),
        metadata: {
          compactionEpoch: malformedCompactionEpoch,
        },
      });

      expect(parsed.metadata?.compactionEpoch).toBeUndefined();
    }
  });
});
