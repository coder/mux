import { describe, expect, it } from "bun:test";
import type { MuxMessage } from "@/common/types/message";
import { applyToolOutputRedaction } from "./applyToolOutputRedaction";

describe("applyToolOutputRedaction", () => {
  it("strips image generation thumbnails from provider-bound tool output", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant" as const,
        parts: [
          {
            type: "dynamic-tool" as const,
            toolCallId: "image-tool-1",
            toolName: "image_generate",
            input: {},
            state: "output-available" as const,
            output: {
              success: true,
              model: "openai:gpt-image-1.5",
              prompt: "square",
              requestedCount: 1,
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
            },
          },
        ],
      },
    ];

    const result = applyToolOutputRedaction(messages);
    const part = result[0]?.parts[0];
    if (part?.type !== "dynamic-tool" || part.state !== "output-available") {
      throw new Error("Expected image generation tool output");
    }
    expect(part.output).toEqual({
      success: true,
      model: "openai:gpt-image-1.5",
      prompt: "square",
      requestedCount: 1,
      images: [
        {
          path: "/tmp/image.png",
          filename: "image.png",
          mediaType: "image/png",
        },
      ],
    });
  });

  it("strips image generation thumbnails from nested code execution tool calls", () => {
    const imageResult = {
      success: true,
      model: "openai:gpt-image-2",
      prompt: "square",
      requestedCount: 1,
      images: [
        {
          path: "/tmp/image.png",
          filename: "image.png",
          mediaType: "image/png",
          thumbnail: {
            data: "nested-large-base64",
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
        role: "assistant" as const,
        parts: [
          {
            type: "dynamic-tool" as const,
            toolCallId: "code-execution-1",
            toolName: "code_execution",
            input: {},
            state: "output-available" as const,
            output: {
              success: true,
              result: "done",
              toolCalls: [
                {
                  toolName: "image_generate",
                  args: { prompt: "square" },
                  result: imageResult,
                  duration_ms: 12,
                },
              ],
            },
            nestedCalls: [
              {
                toolCallId: "nested-image-1",
                toolName: "image_generate",
                input: { prompt: "square" },
                state: "output-available" as const,
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
      throw new Error("Expected code execution tool output");
    }
    expect(part.output).toEqual({
      success: true,
      result: "done",
      toolCalls: [
        {
          toolName: "image_generate",
          args: { prompt: "square" },
          result: {
            success: true,
            model: "openai:gpt-image-2",
            prompt: "square",
            requestedCount: 1,
            images: [{ path: "/tmp/image.png", filename: "image.png", mediaType: "image/png" }],
          },
          duration_ms: 12,
        },
      ],
    });
    expect(part.nestedCalls?.[0]?.output).toEqual({
      success: true,
      model: "openai:gpt-image-2",
      prompt: "square",
      requestedCount: 1,
      images: [{ path: "/tmp/image.png", filename: "image.png", mediaType: "image/png" }],
    });
  });
});
