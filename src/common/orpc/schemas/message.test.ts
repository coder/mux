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
