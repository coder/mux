import { describe, expect, it } from "@jest/globals";
import type { MuxMessage } from "@/common/types/message";
import { convertDataUriFilePartsForSdk } from "./convertDataUriFilePartsForSdk";

describe("convertDataUriFilePartsForSdk", () => {
  it("converts base64 data URI file parts to raw base64 payloads", () => {
    const base64 = Buffer.from("png-bytes", "utf8").toString("base64");
    const input: MuxMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "look" },
          {
            type: "file",
            mediaType: "image/png",
            url: `data:image/png;base64,${base64}`,
          },
        ],
      },
    ];

    const converted = convertDataUriFilePartsForSdk(input);

    expect(converted).not.toBe(input);
    const filePart = converted[0].parts.find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    if (filePart?.type === "file") {
      expect(filePart.mediaType).toBe("image/png");
      expect(filePart.url).toBe(base64);
    }
  });

  it("returns the original array when there are no data URI file parts", () => {
    const input: MuxMessage[] = [
      {
        id: "u2",
        role: "user",
        parts: [
          { type: "text", text: "look" },
          { type: "file", mediaType: "image/png", url: "https://example.com/image.png" },
        ],
      },
    ];

    const converted = convertDataUriFilePartsForSdk(input);
    expect(converted).toBe(input);
  });

  it("does not rewrite assistant messages", () => {
    const base64 = Buffer.from("assistant", "utf8").toString("base64");
    const input: MuxMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "file", mediaType: "image/png", url: `data:image/png;base64,${base64}` }],
      },
    ];

    const converted = convertDataUriFilePartsForSdk(input);
    expect(converted).toBe(input);
  });

  it("converts multiple user file parts and keeps non-data URLs unchanged", () => {
    const pngBase64 = Buffer.from("png", "utf8").toString("base64");
    const pdfBase64 = Buffer.from("pdf", "utf8").toString("base64");

    const input: MuxMessage[] = [
      {
        id: "u3",
        role: "user",
        parts: [
          { type: "text", text: "files" },
          { type: "file", mediaType: "image/png", url: `data:image/png;base64,${pngBase64}` },
          {
            type: "file",
            mediaType: "application/pdf",
            url: `data:application/pdf;base64,${pdfBase64}`,
          },
          { type: "file", mediaType: "image/jpeg", url: "https://example.com/photo.jpg" },
        ],
      },
    ];

    const converted = convertDataUriFilePartsForSdk(input);
    const convertedFileParts = converted[0].parts.filter((part) => part.type === "file");

    expect(convertedFileParts).toHaveLength(3);
    expect(convertedFileParts[0].url).toBe(pngBase64);
    expect(convertedFileParts[1].url).toBe(pdfBase64);
    expect(convertedFileParts[2].url).toBe("https://example.com/photo.jpg");
  });

  it("converts URL-encoded SVG data URIs to base64", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>';
    const encodedSvg = encodeURIComponent(svg);

    const input: MuxMessage[] = [
      {
        id: "u4",
        role: "user",
        parts: [
          {
            type: "file",
            mediaType: "image/svg+xml",
            url: `data:image/svg+xml,${encodedSvg}`,
          },
        ],
      },
    ];

    const converted = convertDataUriFilePartsForSdk(input);
    const filePart = converted[0].parts[0];

    expect(filePart.type).toBe("file");
    if (filePart.type === "file") {
      expect(filePart.mediaType).toBe("image/svg+xml");
      expect(filePart.url).toBe(Buffer.from(svg, "utf8").toString("base64"));
    }
  });

  it("throws for malformed data URIs missing a comma separator", () => {
    const input: MuxMessage[] = [
      {
        id: "u5",
        role: "user",
        parts: [
          {
            type: "file",
            mediaType: "image/png",
            url: "data:image/png;base64not-a-valid-data-url",
          },
        ],
      },
    ];

    expect(() => convertDataUriFilePartsForSdk(input)).toThrow(
      "Malformed data URI in file part: missing comma"
    );
  });
});
