import { describe, it, expect } from "@jest/globals";
import type { ModelMessage } from "ai";
import { normalizeToolCallIds, shortenToolCallId } from "./normalizeToolCallIds";

/** Helper: a string of exactly `n` characters. */
function makeId(n: number, prefix = "call_"): string {
  return prefix + "x".repeat(Math.max(0, n - prefix.length));
}

describe("shortenToolCallId", () => {
  it("returns a string of exactly 64 characters", () => {
    const result = shortenToolCallId("a".repeat(100));
    expect(result.length).toBe(64);
  });

  it("starts with call_ prefix", () => {
    const result = shortenToolCallId("something-very-long");
    expect(result.startsWith("call_")).toBe(true);
  });

  it("is deterministic — same input gives same output", () => {
    const longId = "x".repeat(200);
    expect(shortenToolCallId(longId)).toBe(shortenToolCallId(longId));
  });

  it("produces different outputs for different inputs", () => {
    const a = shortenToolCallId("a".repeat(100));
    const b = shortenToolCallId("b".repeat(100));
    expect(a).not.toBe(b);
  });
});

describe("normalizeToolCallIds", () => {
  const shortId = makeId(64); // exactly at the limit — should NOT be rewritten
  const longId = makeId(65); // one over the limit — should be rewritten
  const veryLongId = makeId(200); // well over the limit

  it("returns the same array reference when no IDs exceed 64 chars", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: shortId, toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: shortId,
            toolName: "bash",
            output: { type: "text" as const, value: "ok" },
          },
        ],
      },
    ];

    const result = normalizeToolCallIds(messages);
    // Same reference means no unnecessary cloning
    expect(result).toBe(messages);
  });

  it("rewrites oversized IDs in both tool-call and tool-result parts", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: longId, toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: longId,
            toolName: "bash",
            output: { type: "text" as const, value: "ok" },
          },
        ],
      },
    ];

    const result = normalizeToolCallIds(messages);

    // Both should have the same normalized ID
    const assistantContent = result[0].content as Array<{ toolCallId: string }>;
    const toolContent = result[1].content as Array<{ toolCallId: string }>;

    expect(assistantContent[0].toolCallId.length).toBeLessThanOrEqual(64);
    expect(toolContent[0].toolCallId.length).toBeLessThanOrEqual(64);
    expect(assistantContent[0].toolCallId).toBe(toolContent[0].toolCallId);
  });

  it("preserves IDs that are within the limit alongside oversized ones", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: shortId, toolName: "bash", input: {} },
          { type: "tool-call", toolCallId: veryLongId, toolName: "edit", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: shortId,
            toolName: "bash",
            output: { type: "text" as const, value: "ok" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: veryLongId,
            toolName: "edit",
            output: { type: "text" as const, value: "done" },
          },
        ],
      },
    ];

    const result = normalizeToolCallIds(messages);

    const assistantContent = result[0].content as Array<{ toolCallId: string }>;
    const toolContent0 = result[1].content as Array<{ toolCallId: string }>;
    const toolContent1 = result[2].content as Array<{ toolCallId: string }>;

    // Short ID untouched
    expect(assistantContent[0].toolCallId).toBe(shortId);
    expect(toolContent0[0].toolCallId).toBe(shortId);

    // Long ID rewritten
    expect(assistantContent[1].toolCallId).not.toBe(veryLongId);
    expect(assistantContent[1].toolCallId.length).toBeLessThanOrEqual(64);
    // Paired result matches
    expect(toolContent1[0].toolCallId).toBe(assistantContent[1].toolCallId);
  });

  it("does not mutate original messages", () => {
    const originalCallId = longId;
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: originalCallId, toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: originalCallId,
            toolName: "bash",
            output: { type: "text" as const, value: "ok" },
          },
        ],
      },
    ];

    normalizeToolCallIds(messages);

    // Original messages untouched
    const assistantContent = messages[0].content as Array<{ toolCallId: string }>;
    const toolContent = messages[1].content as Array<{ toolCallId: string }>;
    expect(assistantContent[0].toolCallId).toBe(originalCallId);
    expect(toolContent[0].toolCallId).toBe(originalCallId);
  });

  it("passes through non-assistant/tool messages unchanged", () => {
    const userMsg: ModelMessage = { role: "user", content: [{ type: "text", text: "hello" }] };
    const systemMsg: ModelMessage = { role: "system", content: "system prompt" };

    const messages: ModelMessage[] = [userMsg, systemMsg];
    const result = normalizeToolCallIds(messages);

    expect(result[0]).toBe(userMsg);
    expect(result[1]).toBe(systemMsg);
  });

  it("handles assistant messages with string content (no tool calls)", () => {
    const messages: ModelMessage[] = [{ role: "assistant", content: "just text" }];

    const result = normalizeToolCallIds(messages);
    expect(result).toBe(messages);
  });
});
