import { describe, it, expect } from "@jest/globals";
import type { MuxMessage } from "@/common/types/message";
import { extractToolMediaAsUserMessages } from "./extractToolMediaAsUserMessages";

describe("extractToolMediaAsUserMessages", () => {
  it("moves base64 media out of tool output and into a synthetic user file part", () => {
    const base64 = "A".repeat(50_000);

    const input: MuxMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "mcp_chrome_devtools_screenshot",
            input: { tabId: 1 },
            state: "output-available",
            output: {
              type: "content",
              value: [{ type: "media", mediaType: "image/png", data: base64 }],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);

    const rewrittenAssistant = rewritten[0];
    expect(rewrittenAssistant.role).toBe("assistant");

    const toolPart = rewrittenAssistant.parts[0];
    expect(toolPart.type).toBe("dynamic-tool");
    if (toolPart.type === "dynamic-tool" && toolPart.state === "output-available") {
      const outputText = JSON.stringify(toolPart.output);
      expect(outputText).toContain("[Image attached:");
      expect(outputText).not.toMatch(/[A]{1000,}/);
    }

    const syntheticUser = rewritten[1];
    expect(syntheticUser.role).toBe("user");
    expect(syntheticUser.metadata?.synthetic).toBe(true);

    const filePart = syntheticUser.parts.find((p) => p.type === "file");
    expect(filePart).toBeDefined();
    if (filePart?.type === "file") {
      expect(filePart.mediaType).toBe("image/png");
      expect(filePart.url.startsWith("data:image/png;base64,")).toBe(true);
      // Full base64 is expected in the file url, but NOT in tool output JSON.
      expect(filePart.url).toContain(base64.slice(0, 100));
    }
  });

  it("is a no-op when tool outputs have no media", () => {
    const input: MuxMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "bash",
            input: { script: "pwd" },
            state: "output-available",
            output: { type: "json", value: { stdout: "/tmp" } },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = extractToolMediaAsUserMessages(input);
    expect(rewritten).toEqual(input);
  });
});
