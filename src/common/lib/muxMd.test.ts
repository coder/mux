import { describe, it, expect } from "bun:test";
import {
  MUX_MD_BASE_URL,
  deleteFromMuxMd,
  downloadFromMuxMd,
  getMuxMdBaseUrl,
  isMuxMdUrl,
  parseMuxMdUrl,
  uploadToMuxMd,
} from "./muxMd";

const itIntegration = process.env.TEST_INTEGRATION === "1" ? it : it.skip;

describe("muxMd", () => {
  describe("getMuxMdBaseUrl", () => {
    it("should default to the production mux.md origin", () => {
      const originalOverride = process.env.MUX_MD_URL_OVERRIDE;

      try {
        delete process.env.MUX_MD_URL_OVERRIDE;
        expect(getMuxMdBaseUrl()).toBe(MUX_MD_BASE_URL);
      } finally {
        if (originalOverride === undefined) {
          delete process.env.MUX_MD_URL_OVERRIDE;
        } else {
          process.env.MUX_MD_URL_OVERRIDE = originalOverride;
        }
      }
    });

    it("should normalize and accept a MUX_MD_URL_OVERRIDE host", () => {
      const originalOverride = process.env.MUX_MD_URL_OVERRIDE;
      process.env.MUX_MD_URL_OVERRIDE = "https://mux-md-staging.test/some/path";

      try {
        expect(getMuxMdBaseUrl()).toBe("https://mux-md-staging.test");

        // Override host should be allowed.
        expect(isMuxMdUrl("https://mux-md-staging.test/abc123#key456")).toBe(true);

        // Production links should still be recognized while an override is set.
        expect(isMuxMdUrl("https://mux.md/abc123#key456")).toBe(true);

        expect(isMuxMdUrl("https://not-mux-md.test/abc123#key456")).toBe(false);
      } finally {
        if (originalOverride === undefined) {
          delete process.env.MUX_MD_URL_OVERRIDE;
        } else {
          process.env.MUX_MD_URL_OVERRIDE = originalOverride;
        }
      }
    });

    it("should prefer window.api.muxMdUrlOverride over process.env", () => {
      const originalOverride = process.env.MUX_MD_URL_OVERRIDE;
      const globalWithWindow = globalThis as unknown as {
        window?: {
          api?: {
            muxMdUrlOverride?: string;
          };
        };
      };
      const originalWindow = globalWithWindow.window;

      process.env.MUX_MD_URL_OVERRIDE = "https://mux-md-staging.test";
      globalWithWindow.window = {
        api: {
          muxMdUrlOverride: "http://localhost:8787/foo",
        },
      };

      try {
        expect(getMuxMdBaseUrl()).toBe("http://localhost:8787");
      } finally {
        if (originalOverride === undefined) {
          delete process.env.MUX_MD_URL_OVERRIDE;
        } else {
          process.env.MUX_MD_URL_OVERRIDE = originalOverride;
        }

        if (originalWindow === undefined) {
          delete globalWithWindow.window;
        } else {
          globalWithWindow.window = originalWindow;
        }
      }
    });

    it("should use globalThis.__MUX_MD_URL_OVERRIDE__ in browser mode without preload", () => {
      const originalOverride = process.env.MUX_MD_URL_OVERRIDE;
      const originalDefineOverride = globalThis.__MUX_MD_URL_OVERRIDE__;
      const globalWithWindow = globalThis as unknown as {
        window?: Record<string, unknown>;
      };
      const originalWindow = globalWithWindow.window;

      // When running `make dev-server`, the renderer runs in a normal browser where `window.api`
      // is not available, so we rely on the Vite-injected define.
      process.env.MUX_MD_URL_OVERRIDE = "https://should-not-be-used.test";
      globalThis.__MUX_MD_URL_OVERRIDE__ = "https://mux-md-staging.test/some/path";
      globalWithWindow.window = {};

      try {
        expect(getMuxMdBaseUrl()).toBe("https://mux-md-staging.test");
      } finally {
        if (originalOverride === undefined) {
          delete process.env.MUX_MD_URL_OVERRIDE;
        } else {
          process.env.MUX_MD_URL_OVERRIDE = originalOverride;
        }

        globalThis.__MUX_MD_URL_OVERRIDE__ = originalDefineOverride;

        if (originalWindow === undefined) {
          delete globalWithWindow.window;
        } else {
          globalWithWindow.window = originalWindow;
        }
      }
    });
  });

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

    expect(uploadResult.url).toContain(`${getMuxMdBaseUrl()}/`);
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
