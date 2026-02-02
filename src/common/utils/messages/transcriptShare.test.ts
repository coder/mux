import { describe, expect, it } from "bun:test";
import type { MuxMessage } from "@/common/types/message";
import { buildChatJsonlForSharing } from "./transcriptShare";

function splitJsonlLines(jsonl: string): string[] {
  return jsonl.split("\n").filter((line) => line.trim().length > 0);
}

describe("buildChatJsonlForSharing", () => {
  it("strips tool output and sets state back to input-available when includeToolOutput=false", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tc-1",
            toolName: "bash",
            state: "output-available",
            input: { script: "echo hi" },
            output: { success: true, output: "hi" },
          },
        ],
      },
    ];

    const jsonl = buildChatJsonlForSharing(messages, { includeToolOutput: false });
    expect(jsonl.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(splitJsonlLines(jsonl)[0]) as MuxMessage;
    const part = parsed.parts[0];
    expect(part.type).toBe("dynamic-tool");

    if (part.type !== "dynamic-tool") {
      throw new Error("Expected tool part");
    }

    expect(part.state).toBe("input-available");
    expect(part).not.toHaveProperty("output");

    // Original messages should be unchanged (no mutation during stripping)
    const originalPart = messages[0].parts[0];
    if (originalPart.type !== "dynamic-tool") {
      throw new Error("Expected tool part");
    }
    expect(originalPart.state).toBe("output-available");
    expect(originalPart).toHaveProperty("output");
  });

  it("strips nestedCalls output and sets nestedCalls state back to input-available when includeToolOutput=false", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tc-1",
            toolName: "code_execution",
            state: "input-available",
            input: { code: "console.log('hi')" },
            nestedCalls: [
              {
                toolCallId: "nested-1",
                toolName: "bash",
                input: { script: "echo nested" },
                output: { success: true, output: "nested" },
                state: "output-available",
              },
            ],
          },
        ],
      },
    ];

    const jsonl = buildChatJsonlForSharing(messages, { includeToolOutput: false });
    const parsed = JSON.parse(splitJsonlLines(jsonl)[0]) as MuxMessage;
    const part = parsed.parts[0];

    if (part.type !== "dynamic-tool") {
      throw new Error("Expected tool part");
    }

    expect(part.state).toBe("input-available");
    expect(part.nestedCalls?.[0].state).toBe("input-available");
    expect(part.nestedCalls?.[0]).not.toHaveProperty("output");

    // Original nested call should still include output
    const originalPart = messages[0].parts[0];
    if (originalPart.type !== "dynamic-tool") {
      throw new Error("Expected tool part");
    }
    expect(originalPart.nestedCalls?.[0].state).toBe("output-available");
    expect(originalPart.nestedCalls?.[0]).toHaveProperty("output");
  });

  it("leaves messages unchanged when includeToolOutput=true", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tc-1",
            toolName: "bash",
            state: "output-available",
            input: { script: "echo hi" },
            output: { success: true, output: "hi" },
            nestedCalls: [
              {
                toolCallId: "nested-1",
                toolName: "file_read",
                input: { file_path: "/tmp/demo.txt" },
                output: { success: true, content: "hello" },
                state: "output-available",
              },
            ],
          },
        ],
      },
    ];

    const jsonl = buildChatJsonlForSharing(messages, { includeToolOutput: true });
    const parsed = JSON.parse(splitJsonlLines(jsonl)[0]) as MuxMessage;

    expect(parsed).toEqual(messages[0]);
  });

  it("produces valid JSONL (each line parses, trailing newline)", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "world" }],
      },
    ];

    const jsonl = buildChatJsonlForSharing(messages);
    expect(jsonl.endsWith("\n")).toBe(true);

    const lines = splitJsonlLines(jsonl);
    expect(lines).toHaveLength(messages.length);

    const parsed = lines.map((line) => JSON.parse(line) as MuxMessage);
    expect(parsed).toEqual(messages);
  });
});
