import { describe, expect, it } from "@jest/globals";
import type { ModelMessage } from "ai";
import sharp from "sharp";
import { MAX_IMAGE_DIMENSION } from "@/common/constants/imageAttachments";
import { extractToolMediaAsUserMessagesFromModelMessages } from "./extractToolMediaAsUserMessagesFromModelMessages";

describe("extractToolMediaAsUserMessagesFromModelMessages", () => {
  it("rewrites attach_file image output for prepareStep messages", async () => {
    const base64 = (
      await sharp({
        create: {
          width: 10,
          height: 10,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .png()
        .toBuffer()
    ).toString("base64");
    const attachFileOutput = {
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
    } as const satisfies { type: "content"; value: unknown[] };

    const input: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "attach_file",
            output: attachFileOutput,
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessagesFromModelMessages(input);
    expect(rewritten).toHaveLength(3);

    const rewrittenTool = rewritten[1];
    expect(rewrittenTool.role).toBe("tool");

    const toolResultPart = (rewrittenTool as Extract<ModelMessage, { role: "tool" }>).content[0];
    if (toolResultPart.type !== "tool-result") throw new Error("Expected tool-result part");
    const outputText = JSON.stringify(toolResultPart.output);
    expect(outputText).toContain("[Attachment attached:");
    expect(outputText).not.toMatch(/[A]{1000,}/);

    const syntheticUser = rewritten[2];
    expect(syntheticUser.role).toBe("user");
    expect(Array.isArray(syntheticUser.content)).toBe(true);

    const imagePart = Array.isArray(syntheticUser.content)
      ? syntheticUser.content.find((part) => part.type === "image")
      : undefined;

    expect(imagePart).toBeDefined();
    if (imagePart?.type === "image") {
      expect(imagePart.mediaType).toBe("image/png");
      expect(imagePart.image).toBe(base64);
    }
  });

  it("self-heals oversized raster tool attachments for prepareStep messages", async () => {
    const oversizedPng = await sharp({
      create: {
        width: 9001,
        height: 10,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const base64 = oversizedPng.toString("base64");
    const attachFileOutput = {
      type: "content",
      value: [
        { type: "text", text: "[Attachment prepared: oversized.png]" },
        {
          type: "media",
          mediaType: "image/png",
          data: base64,
          filename: "oversized.png",
        },
      ],
    } as const satisfies { type: "content"; value: unknown[] };

    const input: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-resize",
            toolName: "attach_file",
            output: attachFileOutput,
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessagesFromModelMessages(input);
    const syntheticUser = rewritten[1];
    expect(syntheticUser.role).toBe("user");
    const imagePart = Array.isArray(syntheticUser.content)
      ? syntheticUser.content.find((part) => part.type === "image")
      : undefined;

    expect(imagePart).toBeDefined();
    if (imagePart?.type !== "image") {
      throw new Error("Expected a synthetic image part for resized tool attachment");
    }

    expect(imagePart.mediaType).toBe("image/png");
    if (typeof imagePart.image !== "string") {
      throw new Error("Expected a base64 image payload for resized tool attachment");
    }

    const metadata = await sharp(Buffer.from(imagePart.image, "base64")).metadata();
    expect(metadata.width).toBe(MAX_IMAGE_DIMENSION);
    expect(metadata.height).toBe(2);
    expect(imagePart.image).not.toBe(base64);
  });

  it("rewrites attach_file PDF output for prepareStep messages", async () => {
    const base64 = Buffer.from("%PDF-1.7").toString("base64");
    const attachFileOutput = {
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
    } as const satisfies { type: "content"; value: unknown[] };

    const input: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call2",
            toolName: "attach_file",
            output: attachFileOutput,
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessagesFromModelMessages(input);
    expect(rewritten).toHaveLength(2);

    const syntheticUser = rewritten[1];
    expect(syntheticUser.role).toBe("user");
    const filePart = Array.isArray(syntheticUser.content)
      ? syntheticUser.content.find((part) => part.type === "file")
      : undefined;

    expect(filePart).toBeDefined();
    if (filePart?.type === "file") {
      expect(filePart.mediaType).toBe("application/pdf");
      expect(filePart.filename).toBe("report pdf");
      expect(filePart.data).toBe(base64);
    }
  });

  it("self-heals oversized SVG tool attachments instead of throwing", async () => {
    const oversizedSvg = `<svg>${"a".repeat(50_001)}</svg>`;
    const base64 = Buffer.from(oversizedSvg, "utf8").toString("base64");
    const attachFileOutput = {
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
    } as const satisfies { type: "content"; value: unknown[] };

    const input: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call3",
            toolName: "attach_file",
            output: attachFileOutput,
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessagesFromModelMessages(input);
    expect(rewritten).toHaveLength(2);
    const syntheticUser = rewritten[1];
    expect(syntheticUser.role).toBe("user");
    expect(Array.isArray(syntheticUser.content)).toBe(true);
    const svgTextPart = Array.isArray(syntheticUser.content)
      ? syntheticUser.content.find(
          (part) =>
            part.type === "text" &&
            part.text.includes("[SVG attachment omitted from provider request:")
        )
      : undefined;
    expect(svgTextPart).toBeDefined();
  });

  it("is a no-op when there is no media", async () => {
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

    const rewritten = await extractToolMediaAsUserMessagesFromModelMessages(input);
    expect(rewritten).toBe(input);
  });
});
