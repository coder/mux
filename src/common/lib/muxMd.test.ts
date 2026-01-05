import { describe, it, expect } from "bun:test";
import {
  isMuxMdUrl,
  parseMuxMdUrl,
  uploadToMuxMd,
  downloadFromMuxMd,
  deleteFromMuxMd,
} from "./muxMd";

const itIntegration = process.env.TEST_INTEGRATION === "1" ? it : it.skip;

describe("muxMd", () => {
  describe("isMuxMdUrl", () => {
    it("should detect valid mux.md URLs", () => {
      expect(isMuxMdUrl("https://mux.md/abc123#key456")).toBe(true);
      expect(isMuxMdUrl("https://mux.md/RQJe3#Fbbhosspt9q9Ig")).toBe(true);
    });

    it("should reject URLs without fragment", () => {
      expect(isMuxMdUrl("https://mux.md/abc123")).toBe(false);
      expect(isMuxMdUrl("https://mux.md/abc123#")).toBe(false);
    });

    it("should reject non-mux.md URLs", () => {
      expect(isMuxMdUrl("https://example.com/page#hash")).toBe(false);
    });
  });

  describe("parseMuxMdUrl", () => {
    it("should extract id and key from URL", () => {
      expect(parseMuxMdUrl("https://mux.md/abc123#key456")).toEqual({
        id: "abc123",
        key: "key456",
      });
    });

    it("should return null for invalid URLs", () => {
      expect(parseMuxMdUrl("https://mux.md/abc123")).toBeNull();
      expect(parseMuxMdUrl("https://mux.md/#key")).toBeNull();
      expect(parseMuxMdUrl("not-a-url")).toBeNull();
    });
  });

  // Round-trip test: upload then download
  itIntegration("should upload and download content correctly", async () => {
    const testContent = "# Test Message\n\nThis is a test of mux.md encryption.";
    const testFileInfo = {
      name: "test-message.md",
      type: "text/markdown",
      size: testContent.length,
      model: "test-model",
    };

    // Upload
    const uploadResult = await uploadToMuxMd(testContent, testFileInfo, {
      expiresAt: new Date(Date.now() + 60000), // Expire in 1 minute
    });

    expect(uploadResult.url).toContain("https://mux.md/");
    expect(uploadResult.url).toContain("#");
    expect(uploadResult.id).toBeTruthy();
    expect(uploadResult.key).toBeTruthy();
    expect(uploadResult.mutateKey).toBeTruthy();

    try {
      // Download and decrypt
      const downloadResult = await downloadFromMuxMd(uploadResult.id, uploadResult.key);

      expect(downloadResult.content).toBe(testContent);
      expect(downloadResult.fileInfo).toBeDefined();
      expect(downloadResult.fileInfo?.name).toBe("test-message.md");
      expect(downloadResult.fileInfo?.model).toBe("test-model");
    } finally {
      // Clean up - delete the uploaded file
      await deleteFromMuxMd(uploadResult.id, uploadResult.mutateKey);
    }
  });

  itIntegration("should fail gracefully for non-existent shares", async () => {
    let error: Error | undefined;
    try {
      await downloadFromMuxMd("nonexistent123", "fakekey456");
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toMatch(/not found|expired/i);
  });
});
