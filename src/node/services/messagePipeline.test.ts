import { describe, expect, it } from "bun:test";
import type { AssistantModelMessage, ModelMessage } from "ai";

import { transformModelMessages } from "@/browser/utils/messages/modelMessageTransform";
import { sanitizeAssistantModelMessages } from "./messagePipeline";

function isAssistantMessage(message: ModelMessage | undefined): message is AssistantModelMessage {
  return message?.role === "assistant";
}

describe("sanitizeAssistantModelMessages", () => {
  it("preserves whitespace-only separators before later text coalescing", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "## Verdict" },
          { type: "text", text: "\n\n" },
          { type: "text", text: "This is now **strong evidence**." },
        ],
      },
    ];

    const sanitized = sanitizeAssistantModelMessages(messages);
    const transformed = transformModelMessages(sanitized, "openai");

    expect(isAssistantMessage(sanitized[0])).toBe(true);
    if (isAssistantMessage(sanitized[0])) {
      expect(sanitized[0].content).toEqual([
        { type: "text", text: "## Verdict\n\nThis is now **strong evidence**." },
      ]);
    }

    expect(isAssistantMessage(transformed[0])).toBe(true);
    if (isAssistantMessage(transformed[0])) {
      expect(transformed[0].content).toEqual([
        { type: "text", text: "## Verdict\n\nThis is now **strong evidence**." },
      ]);
    }
  });

  it("still filters assistant messages that contain only whitespace text", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "\n" },
          { type: "text", text: "\t " },
        ],
      },
    ];

    expect(sanitizeAssistantModelMessages(messages)).toEqual([]);
  });
});
