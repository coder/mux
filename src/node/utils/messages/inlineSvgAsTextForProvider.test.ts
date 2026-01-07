import { describe, it, expect } from "@jest/globals";
import type { MuxMessage } from "@/common/types/message";
import { inlineSvgAsTextForProvider } from "./inlineSvgAsTextForProvider";

describe("inlineSvgAsTextForProvider", () => {
  it("replaces base64 SVG file parts with text parts", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
    const b64 = Buffer.from(svg, "utf8").toString("base64");

    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        metadata: { timestamp: 1, historySequence: 1 },
        parts: [
          { type: "text", text: "hi" },
          { type: "file", mediaType: "image/svg+xml", url: `data:image/svg+xml;base64,${b64}` },
        ],
      },
    ];

    const result = inlineSvgAsTextForProvider(messages, "openai");

    expect(result[0].parts.some((p) => p.type === "file")).toBe(false);

    const textParts = result[0].parts.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(2);
    expect(textParts[1].text).toContain("```svg");
    expect(textParts[1].text).toContain(svg);
  });

  it("supports URL-encoded SVG data URLs", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Hello</text></svg>';
    const encoded = encodeURIComponent(svg);

    const messages: MuxMessage[] = [
      {
        id: "user-2",
        role: "user",
        metadata: { timestamp: 1, historySequence: 1 },
        parts: [
          { type: "text", text: "hi" },
          { type: "file", mediaType: "image/svg+xml", url: `data:image/svg+xml,${encoded}` },
        ],
      },
    ];

    const result = inlineSvgAsTextForProvider(messages, "openai");

    const inlined = result[0].parts.filter((p) => p.type === "text")[1];
    expect(inlined.text).toContain(svg);
  });

  it("throws when decoded SVG exceeds max bytes", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg">' + "a".repeat(100) + "</svg>";
    const b64 = Buffer.from(svg, "utf8").toString("base64");

    const messages: MuxMessage[] = [
      {
        id: "user-3",
        role: "user",
        metadata: { timestamp: 1, historySequence: 1 },
        parts: [
          { type: "text", text: "hi" },
          { type: "file", mediaType: "image/svg+xml", url: `data:image/svg+xml;base64,${b64}` },
        ],
      },
    ];

    expect(() => inlineSvgAsTextForProvider(messages, "openai", { maxSvgTextBytes: 10 })).toThrow(
      "too large"
    );
  });

  it("returns the same array when there are no SVG parts", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-4",
        role: "user",
        metadata: { timestamp: 1, historySequence: 1 },
        parts: [{ type: "text", text: "hi" }],
      },
    ];

    const result = inlineSvgAsTextForProvider(messages, "openai");
    expect(result).toBe(messages);
  });
});
