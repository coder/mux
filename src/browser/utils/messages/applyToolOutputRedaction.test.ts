import { describe, expect, it } from "bun:test";
import type { MuxMessage } from "@/common/types/message";
import { applyToolOutputRedaction } from "./applyToolOutputRedaction";

describe("applyToolOutputRedaction", () => {
  it("strips UI-only fields from provider-bound tool output", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tool-1",
            toolName: "ask_user_question",
            input: {},
            state: "output-available",
            output: {
              success: true,
              answer: "continue",
              ui_only: { ask_user_question: { questions: [], answers: {} } },
            },
          },
        ],
      },
    ];

    const result = applyToolOutputRedaction(messages);
    const part = result[0]?.parts[0];
    if (part?.type !== "dynamic-tool" || part.state !== "output-available") {
      throw new Error("Expected dynamic tool output");
    }

    expect(part.output).toEqual({ success: true, answer: "continue" });
  });

  it("scrubs legacy image tool payloads before replaying history to providers", () => {
    const imageResult = {
      success: true,
      model: "openai:gpt-image-2",
      prompt: "square",
      requestedCount: 1,
      source: {
        path: "/tmp/source.png",
        resolvedPath: "/home/user/project/source.png",
        sizeBytes: 100,
      },
      images: [
        {
          path: "/tmp/image.png",
          filename: "image.png",
          mediaType: "image/png",
          thumbnail: {
            data: "large-base64",
            mediaType: "image/webp",
            width: 512,
            height: 512,
          },
        },
      ],
    };
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "code-execution-1",
            toolName: "code_execution",
            input: {},
            state: "output-available",
            output: {
              success: true,
              toolCalls: [
                {
                  toolName: "image_generate",
                  result: imageResult,
                },
              ],
            },
            nestedCalls: [
              {
                toolCallId: "nested-image-1",
                toolName: "image_generate",
                input: { prompt: "square" },
                state: "output-available",
                output: imageResult,
              },
            ],
          },
        ],
      },
    ];

    const result = applyToolOutputRedaction(messages);
    const part = result[0]?.parts[0];
    if (part?.type !== "dynamic-tool" || part.state !== "output-available") {
      throw new Error("Expected dynamic tool output");
    }

    expect(part.output).toEqual({
      success: true,
      toolCalls: [
        {
          toolName: "image_generate",
          result: {
            success: true,
            model: "openai:gpt-image-2",
            prompt: "square",
            requestedCount: 1,
            source: {
              path: "/tmp/source.png",
              sizeBytes: 100,
            },
            images: [{ path: "/tmp/image.png", filename: "image.png", mediaType: "image/png" }],
          },
        },
      ],
    });
    expect(part.nestedCalls?.[0]?.output).toEqual({
      success: true,
      model: "openai:gpt-image-2",
      prompt: "square",
      requestedCount: 1,
      source: {
        path: "/tmp/source.png",
        sizeBytes: 100,
      },
      images: [{ path: "/tmp/image.png", filename: "image.png", mediaType: "image/png" }],
    });
  });

  it("sanitizes binary-like provider output strings for top-level and nested tools", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tool-1",
            toolName: "example_tool",
            input: {},
            state: "output-available",
            output: {
              success: false,
              error: "Invalid JSON response: \u001b\u0000\ufffdpayload",
            },
            nestedCalls: [
              {
                toolCallId: "nested-tool-1",
                toolName: "nested_tool",
                input: {},
                state: "output-available",
                output: {
                  success: false,
                  error: "Nested bad body \u0000",
                },
              },
            ],
          },
        ],
      },
    ];

    const result = applyToolOutputRedaction(messages);
    const part = result[0]?.parts[0];
    if (part?.type !== "dynamic-tool" || part.state !== "output-available") {
      throw new Error("Expected dynamic tool output");
    }

    const output = part.output as { success?: unknown; error?: unknown };
    expect(output.success).toBe(false);
    expect(output.error).not.toBe("Invalid JSON response: \u001b\u0000\ufffdpayload");
    expect(output.error).toEqual(expect.stringContaining("nul=1"));

    const nestedOutput = part.nestedCalls?.[0]?.output as
      | { success?: unknown; error?: unknown }
      | undefined;
    expect(nestedOutput?.success).toBe(false);
    expect(nestedOutput?.error).not.toBe("Nested bad body \u0000");
    expect(nestedOutput?.error).toEqual(expect.stringContaining("nul=1"));
  });
});
