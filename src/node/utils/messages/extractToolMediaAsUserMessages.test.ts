import { describe, expect, it } from "@jest/globals";
import type { MuxMessage } from "@/common/types/message";
import { extractToolMediaAsUserMessages } from "./extractToolMediaAsUserMessages";

describe("extractToolMediaAsUserMessages", () => {
  it("rewrites attach_file image output into a synthetic user file part", () => {
    const base64 = "A".repeat(50_000);

    const input: MuxMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "attach_file",
            input: { path: "fixtures/screenshot.png" },
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "text", text: "[Attachment prepared: screenshot.png]" },
                {
                  type: "media",
                  mediaType: "image/png",
                  data: base64,
                  filename: "screenshot.png",
                },
              ],
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
      expect(outputText).toContain("[Attachment attached:");
      expect(outputText).not.toMatch(/[A]{1000,}/);
    }

    const syntheticUser = rewritten[1];
    expect(syntheticUser.role).toBe("user");
    expect(syntheticUser.metadata?.synthetic).toBe(true);
    expect(syntheticUser.parts[0]).toEqual({
      type: "text",
      text: "[Attached 1 attachment(s) from tool output]",
    });

    const filePart = syntheticUser.parts.find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    if (filePart?.type === "file") {
      expect(filePart.mediaType).toBe("image/png");
      expect(filePart.filename).toBe("screenshot.png");
      expect(filePart.url.startsWith("data:image/png;base64,")).toBe(true);
      expect(filePart.url).toContain(base64.slice(0, 100));
    }
  });

  it("rewrites attach_file PDF output into a synthetic user file part", () => {
    const base64 = Buffer.from("%PDF-1.7").toString("base64");

    const input: MuxMessage[] = [
      {
        id: "a2",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call2",
            toolName: "attach_file",
            input: { path: "/tmp/report.pdf" },
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "text", text: "[Attachment prepared: report.pdf]" },
                {
                  type: "media",
                  mediaType: "application/pdf",
                  data: base64,
                  filename: "report.pdf",
                },
              ],
            },
          },
        ],
        metadata: { timestamp: 2 },
      },
    ];

    const rewritten = extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);

    const syntheticUser = rewritten[1];
    const filePart = syntheticUser.parts.find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    if (filePart?.type === "file") {
      expect(filePart.mediaType).toBe("application/pdf");
      expect(filePart.filename).toBe("report pdf");
      expect(filePart.url).toBe(`data:application/pdf;base64,${base64}`);
    }
  });

  it("sanitizes extracted PDF filenames in synthetic user file parts", () => {
    const base64 = Buffer.from("%PDF-1.7").toString("base64");

    const input: MuxMessage[] = [
      {
        id: "a3",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call3",
            toolName: "attach_file",
            input: { path: "/tmp/report.pdf" },
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "text", text: "[Attachment prepared: report.pdf]" },
                {
                  type: "media",
                  mediaType: "application/pdf",
                  data: base64,
                  filename: "report.pdf",
                },
              ],
            },
          },
        ],
        metadata: { timestamp: 3 },
      },
    ];

    const rewritten = extractToolMediaAsUserMessages(input);
    const syntheticUser = rewritten[1];
    const filePart = syntheticUser.parts.find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    if (filePart?.type === "file") {
      expect(filePart.filename).toBe("report pdf");
    }
  });

  it("inlines extracted SVG attachments as text instead of synthetic file parts", () => {
    const base64 = Buffer.from('<svg><rect width="10" height="10"/></svg>', "utf8").toString(
      "base64"
    );

    const input: MuxMessage[] = [
      {
        id: "a4",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call4",
            toolName: "attach_file",
            input: { path: "/tmp/diagram.svg" },
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "text", text: "[Attachment prepared: diagram.svg]" },
                {
                  type: "media",
                  mediaType: "image/svg+xml",
                  data: base64,
                  filename: "diagram.svg",
                },
              ],
            },
          },
        ],
        metadata: { timestamp: 4 },
      },
    ];

    const rewritten = extractToolMediaAsUserMessages(input);
    const syntheticUser = rewritten[1];
    expect(syntheticUser.parts.some((part) => part.type === "file")).toBe(false);
    const svgTextPart = syntheticUser.parts.find(
      (part) => part.type === "text" && part.text.includes("[SVG attachment converted to text")
    );
    expect(svgTextPart).toBeDefined();
  });

  it("does not rewrite unrelated tool outputs", () => {
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
    expect(rewritten).toBe(input);
  });
});
