import { describe, it, expect } from "bun:test";
import { transformMCPResult, MAX_IMAGE_DATA_BYTES } from "./mcpResultTransform";

describe("transformMCPResult", () => {
  describe("image data overflow handling", () => {
    it("should pass through small images unchanged", () => {
      const smallImageData = "a".repeat(1000); // 1KB of base64 data
      const result = transformMCPResult({
        content: [
          { type: "text", text: "Screenshot taken" },
          { type: "image", data: smallImageData, mimeType: "image/png" },
        ],
      });

      expect(result).toEqual({
        type: "content",
        value: [
          { type: "text", text: "Screenshot taken" },
          { type: "media", data: smallImageData, mediaType: "image/png" },
        ],
      });
    });

    it("should truncate large image data to prevent context overflow", () => {
      // Create a large base64 string that simulates a big screenshot
      // A typical screenshot could be 500KB-2MB of base64 data
      const largeImageData = "x".repeat(MAX_IMAGE_DATA_BYTES + 100_000);
      const result = transformMCPResult({
        content: [
          { type: "text", text: "Screenshot taken" },
          { type: "image", data: largeImageData, mimeType: "image/png" },
        ],
      });

      const transformed = result as {
        type: "content";
        value: Array<{ type: string; text?: string; data?: string; mediaType?: string }>;
      };

      expect(transformed.type).toBe("content");
      expect(transformed.value).toHaveLength(2);
      expect(transformed.value[0]).toEqual({ type: "text", text: "Screenshot taken" });

      // The image should be replaced with a text message explaining the truncation
      const imageResult = transformed.value[1];
      expect(imageResult.type).toBe("text");
      expect(imageResult.text).toContain("Image data too large");
      expect(imageResult.text).toContain(String(largeImageData.length));
    });

    it("should handle multiple images, truncating only the oversized ones", () => {
      const smallImageData = "small".repeat(100);
      const largeImageData = "x".repeat(MAX_IMAGE_DATA_BYTES + 50_000);

      const result = transformMCPResult({
        content: [
          { type: "image", data: smallImageData, mimeType: "image/png" },
          { type: "image", data: largeImageData, mimeType: "image/jpeg" },
        ],
      });

      const transformed = result as {
        type: "content";
        value: Array<{ type: string; text?: string; data?: string; mediaType?: string }>;
      };

      expect(transformed.value).toHaveLength(2);
      // Small image passes through
      expect(transformed.value[0]).toEqual({
        type: "media",
        data: smallImageData,
        mediaType: "image/png",
      });
      // Large image gets truncated with explanation
      expect(transformed.value[1].type).toBe("text");
      expect(transformed.value[1].text).toContain("Image data too large");
    });

    it("should report approximate file size in KB/MB in truncation message", () => {
      // ~1.5MB of base64 data
      const largeImageData = "y".repeat(1_500_000);
      const result = transformMCPResult({
        content: [{ type: "image", data: largeImageData, mimeType: "image/png" }],
      });

      const transformed = result as {
        type: "content";
        value: Array<{ type: string; text?: string }>;
      };

      expect(transformed.value[0].type).toBe("text");
      // Should mention MB since it's over 1MB
      expect(transformed.value[0].text).toMatch(/\d+(\.\d+)?\s*MB/i);
    });
  });

  describe("existing functionality", () => {
    it("should pass through error results unchanged", () => {
      const errorResult = {
        isError: true,
        content: [{ type: "text" as const, text: "Error!" }],
      };
      expect(transformMCPResult(errorResult)).toBe(errorResult);
    });

    it("should pass through toolResult unchanged", () => {
      const toolResult = { toolResult: { foo: "bar" } };
      expect(transformMCPResult(toolResult)).toBe(toolResult);
    });

    it("should pass through results without content array", () => {
      const noContent = { something: "else" };
      expect(transformMCPResult(noContent as never)).toBe(noContent);
    });

    it("should pass through text-only content without transformation wrapper", () => {
      const textOnly = {
        content: [
          { type: "text" as const, text: "Hello" },
          { type: "text" as const, text: "World" },
        ],
      };
      // No images = no transformation needed
      expect(transformMCPResult(textOnly)).toBe(textOnly);
    });

    it("should convert resource content to text", () => {
      const result = transformMCPResult({
        content: [
          { type: "image", data: "abc", mimeType: "image/png" },
          { type: "resource", resource: { uri: "file:///test.txt", text: "File content" } },
        ],
      });

      const transformed = result as {
        type: "content";
        value: Array<{ type: string; text?: string; data?: string }>;
      };

      expect(transformed.value[1]).toEqual({ type: "text", text: "File content" });
    });

    it("should default to image/png when mimeType is missing", () => {
      const result = transformMCPResult({
        content: [{ type: "image", data: "abc", mimeType: "" }],
      });

      const transformed = result as {
        type: "content";
        value: Array<{ type: string; mediaType?: string }>;
      };

      expect(transformed.value[0].mediaType).toBe("image/png");
    });
  });
});
