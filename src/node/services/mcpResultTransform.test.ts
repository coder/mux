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

    it("should omit large image data to prevent context overflow", () => {
      // Create a large base64 string that simulates a screenshot
      // Even 50KB of base64 would be ~12,500 tokens when treated as text
      const largeImageData = "x".repeat(MAX_IMAGE_DATA_BYTES + 10_000);
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

      // The image should be replaced with a text message explaining why it was omitted
      const imageResult = transformed.value[1];
      expect(imageResult.type).toBe("text");
      expect(imageResult.text).toContain("Image omitted");
      expect(imageResult.text).toContain("per-image guard");
    });

    it("should handle multiple images, omitting only the oversized ones", () => {
      const smallImageData = "small".repeat(100);
      const largeImageData = "x".repeat(MAX_IMAGE_DATA_BYTES + 5_000);

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
      // Large image gets omitted with explanation
      expect(transformed.value[1].type).toBe("text");
      expect(transformed.value[1].text).toContain("Image omitted");
    });

    it("should mention size and guard limit in omission message", () => {
      // 100KB of base64 data should trigger the guard if limit is smaller, but we keep it big here
      const largeImageData = "y".repeat(MAX_IMAGE_DATA_BYTES + 1_000);
      const result = transformMCPResult({
        content: [{ type: "image", data: largeImageData, mimeType: "image/png" }],
      });

      const transformed = result as {
        type: "content";
        value: Array<{ type: string; text?: string }>;
      };

      expect(transformed.value[0].type).toBe("text");
      // Should mention size and guard
      expect(transformed.value[0].text).toMatch(/Image omitted/);
      expect(transformed.value[0].text).toMatch(/per-image guard/i);
      expect(transformed.value[0].text).toMatch(/MB|KB/);
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
