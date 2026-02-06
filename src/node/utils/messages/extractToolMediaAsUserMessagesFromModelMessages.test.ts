import { describe, it, expect } from "@jest/globals";
import type { ModelMessage } from "ai";
import { extractToolMediaAsUserMessagesFromModelMessages } from "./extractToolMediaAsUserMessagesFromModelMessages";

describe("extractToolMediaAsUserMessagesFromModelMessages", () => {
  it("moves base64 media out of tool output and into a synthetic user image part", () => {
    const base64 = "A".repeat(50_000);

    const input: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "mcp_chrome_devtools_screenshot",
            output: {
              type: "content",
              value: [{ type: "media", mediaType: "image/png", data: base64 }],
            },
          },
        ],
      },
    ];

    const rewritten = extractToolMediaAsUserMessagesFromModelMessages(input);
    expect(rewritten).toHaveLength(3);

    const rewrittenTool = rewritten[1];
    expect(rewrittenTool.role).toBe("tool");

    const toolResultPart = (rewrittenTool as Extract<ModelMessage, { role: "tool" }>).content[0];
    if (toolResultPart.type !== "tool-result") throw new Error("Expected tool-result part");
    const outputText = JSON.stringify(toolResultPart.output);
    expect(outputText).toContain("[Image attached:");
    expect(outputText).not.toMatch(/[A]{1000,}/);

    const syntheticUser = rewritten[2];
    expect(syntheticUser.role).toBe("user");
    expect(Array.isArray(syntheticUser.content)).toBe(true);

    const imagePart = Array.isArray(syntheticUser.content)
      ? syntheticUser.content.find((p) => p.type === "image")
      : undefined;

    expect(imagePart).toBeDefined();
    if (imagePart?.type === "image") {
      expect(imagePart.mediaType).toBe("image/png");
      expect(imagePart.image).toBe(base64);
    }
  });

  it("is a no-op when tool outputs have no media", () => {
    const input: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "bash",
            output: { type: "json", value: { stdout: "/tmp" } },
          },
        ],
      },
    ];

    const rewritten = extractToolMediaAsUserMessagesFromModelMessages(input);
    expect(rewritten).toBe(input);
  });
});
