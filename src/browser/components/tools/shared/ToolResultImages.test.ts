import { describe, it, expect } from "bun:test";
import { extractImagesFromToolResult } from "./ToolResultImages";

describe("extractImagesFromToolResult", () => {
  it("should extract images from MCP content result format", () => {
    const result = {
      type: "content",
      value: [
        { type: "text", text: "Screenshot taken" },
        { type: "media", data: "base64imagedata", mediaType: "image/png" },
      ],
    };

    const images = extractImagesFromToolResult(result);

    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({
      type: "media",
      data: "base64imagedata",
      mediaType: "image/png",
    });
  });

  it("should extract multiple images", () => {
    const result = {
      type: "content",
      value: [
        { type: "media", data: "image1data", mediaType: "image/png" },
        { type: "text", text: "Some text" },
        { type: "media", data: "image2data", mediaType: "image/jpeg" },
      ],
    };

    const images = extractImagesFromToolResult(result);

    expect(images).toHaveLength(2);
    expect(images[0].mediaType).toBe("image/png");
    expect(images[1].mediaType).toBe("image/jpeg");
  });

  it("should return empty array for non-content results", () => {
    expect(extractImagesFromToolResult({ success: true })).toEqual([]);
    expect(extractImagesFromToolResult(null)).toEqual([]);
    expect(extractImagesFromToolResult(undefined)).toEqual([]);
    expect(extractImagesFromToolResult("string")).toEqual([]);
    expect(extractImagesFromToolResult(123)).toEqual([]);
  });

  it("should return empty array for content without images", () => {
    const result = {
      type: "content",
      value: [
        { type: "text", text: "Just text" },
        { type: "text", text: "More text" },
      ],
    };

    expect(extractImagesFromToolResult(result)).toEqual([]);
  });

  it("should skip malformed media entries", () => {
    const result = {
      type: "content",
      value: [
        { type: "media", data: "valid", mediaType: "image/png" }, // Valid
        { type: "media", data: 123, mediaType: "image/png" }, // Invalid: data not string
        { type: "media", data: "valid", mediaType: null }, // Invalid: mediaType not string
        { type: "media" }, // Invalid: missing fields
      ],
    };

    const images = extractImagesFromToolResult(result);

    expect(images).toHaveLength(1);
    expect(images[0].data).toBe("valid");
  });

  it("should return empty for wrong type value", () => {
    expect(extractImagesFromToolResult({ type: "error", value: [] })).toEqual([]);
    expect(extractImagesFromToolResult({ type: "content", value: "not-array" })).toEqual([]);
  });
});
