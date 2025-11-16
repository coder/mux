import { describe, it, expect } from "@jest/globals";
import type { MuxMessage } from "@/common/types/message";
import { sanitizeToolInputs } from "./sanitizeToolInput";

describe("sanitizeToolInputs", () => {
  it("should handle the actual malformed message from httpjail-coder workspace", () => {
    // This is the actual problematic message that caused the bug
    const problematicMessage: MuxMessage = {
      id: "assistant-1761527027508-karjrpf3g",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: 1761527027508,
        partial: true,
      },
      parts: [
        {
          type: "text",
          text: "I'll explore this repository.",
        },
        {
          type: "dynamic-tool",
          toolCallId: "toolu_01DXeXp8oArG4PzT9rk4hz5c",
          toolName: "bash",
          state: "output-available",
          // THIS IS THE MALFORMED INPUT - string instead of object
          input: '{"script" timeout_secs="10": "ls"}',
          output: {
            error: "Invalid input for tool bash: JSON parsing failed",
          },
        },
      ],
    };

    const sanitized = sanitizeToolInputs([problematicMessage]);
    const sanitizedTool = sanitized[0].parts[1];

    if (sanitizedTool.type === "dynamic-tool") {
      // Should be converted to empty object
      expect(sanitizedTool.input).toEqual({});
    }
  });

  it("should convert string inputs to empty objects", () => {
    const messages: MuxMessage[] = [
      {
        id: "test-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "toolu_01test",
            toolName: "bash",
            state: "output-available",
            input: "not an object",
            output: { error: "Invalid input" },
          },
        ],
        metadata: { timestamp: Date.now(), historySequence: 1 },
      },
    ];

    const sanitized = sanitizeToolInputs(messages);
    expect(sanitized[0].parts[0]).toMatchObject({
      type: "dynamic-tool",
      input: {}, // Should be converted to empty object
    });
  });

  it("should keep valid object inputs unchanged", () => {
    const messages: MuxMessage[] = [
      {
        id: "test-2",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "toolu_02test",
            toolName: "bash",
            state: "output-available",
            input: { script: "ls", timeout_secs: 10 },
            output: { success: true },
          },
        ],
        metadata: { timestamp: Date.now(), historySequence: 2 },
      },
    ];

    const sanitized = sanitizeToolInputs(messages);
    expect(sanitized[0].parts[0]).toMatchObject({
      type: "dynamic-tool",
      input: { script: "ls", timeout_secs: 10 },
    });
  });

  it("should not modify non-assistant messages", () => {
    const messages: MuxMessage[] = [
      {
        id: "test-3",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { timestamp: Date.now(), historySequence: 3 },
      },
    ];

    const sanitized = sanitizeToolInputs(messages);
    expect(sanitized).toEqual(messages);
  });

  it("should handle messages with multiple parts", () => {
    const messages: MuxMessage[] = [
      {
        id: "test-4",
        role: "assistant",
        parts: [
          { type: "text", text: "Let me run this command" },
          {
            type: "dynamic-tool",
            toolCallId: "toolu_04test",
            toolName: "bash",
            state: "output-available",
            input: "malformed",
            output: { error: "bad" },
          },
          { type: "text", text: "Done" },
        ],
        metadata: { timestamp: Date.now(), historySequence: 4 },
      },
    ];

    const sanitized = sanitizeToolInputs(messages);
    expect(sanitized[0].parts[1]).toMatchObject({
      type: "dynamic-tool",
      input: {},
    });
    // Other parts should be unchanged
    expect(sanitized[0].parts[0]).toEqual({ type: "text", text: "Let me run this command" });
    expect(sanitized[0].parts[2]).toEqual({ type: "text", text: "Done" });
  });

  it("should handle null input", () => {
    const messages: MuxMessage[] = [
      {
        id: "test-null",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "toolu_null",
            toolName: "bash",
            state: "output-available",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            input: null as any,
            output: { error: "Invalid" },
          },
        ],
        metadata: { timestamp: Date.now(), historySequence: 1 },
      },
    ];

    const sanitized = sanitizeToolInputs(messages);
    const toolPart = sanitized[0].parts[0];
    if (toolPart.type === "dynamic-tool") {
      expect(toolPart.input).toEqual({});
    }
  });

  it("should handle array input", () => {
    const messages: MuxMessage[] = [
      {
        id: "test-array",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "toolu_array",
            toolName: "bash",
            state: "output-available",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            input: ["not", "valid"] as any,
            output: { error: "Invalid" },
          },
        ],
        metadata: { timestamp: Date.now(), historySequence: 1 },
      },
    ];

    const sanitized = sanitizeToolInputs(messages);
    const toolPart = sanitized[0].parts[0];
    if (toolPart.type === "dynamic-tool") {
      expect(toolPart.input).toEqual({});
    }
  });
});
