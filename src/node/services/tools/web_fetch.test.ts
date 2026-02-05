import { describe, it, expect } from "bun:test";
import { createWebFetchTool } from "./web_fetch";
import type { WebFetchToolArgs, WebFetchToolResult } from "@/common/types/tools";
import { WEB_FETCH_MAX_OUTPUT_BYTES } from "@/common/constants/toolLimits";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import { isMuxMdUrl, parseMuxMdUrl, uploadToMuxMd, deleteFromMuxMd } from "@/common/lib/muxMd";
import * as fs from "fs/promises";
import * as path from "path";

import type { ToolCallOptions } from "ai";

// ToolCallOptions stub for testing

const itIntegration = process.env.TEST_INTEGRATION === "1" ? it : it.skip;
const toolCallOptions: ToolCallOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

// Helper to create web_fetch tool with real LocalRuntime
function createTestWebFetchTool() {
  const tempDir = new TestTempDir("test-web-fetch");
  const config = createTestToolConfig(tempDir.path);
  const tool = createWebFetchTool(config);

  return {
    tool,
    tempDir,
    [Symbol.dispose]() {
      tempDir[Symbol.dispose]();
    },
  };
}

describe("mux.md URL helpers", () => {
  describe("isMuxMdUrl", () => {
    it("should detect valid mux.md URLs", () => {
      expect(isMuxMdUrl("https://mux.md/abc123#key456")).toBe(true);
      expect(isMuxMdUrl("https://mux.md/RQJe3#Fbbhosspt9q9Ig")).toBe(true);
    });

    it("should reject mux.md URLs without hash", () => {
      expect(isMuxMdUrl("https://mux.md/abc123")).toBe(false);
    });

    it("should reject mux.md URLs with empty hash", () => {
      expect(isMuxMdUrl("https://mux.md/abc123#")).toBe(false);
    });

    it("should reject non-mux.md URLs", () => {
      expect(isMuxMdUrl("https://example.com/page#hash")).toBe(false);
      expect(isMuxMdUrl("https://other.md/abc#key")).toBe(false);
    });

    it("should handle invalid URLs gracefully", () => {
      expect(isMuxMdUrl("not-a-url")).toBe(false);
      expect(isMuxMdUrl("")).toBe(false);
    });
  });

  describe("parseMuxMdUrl", () => {
    it("should extract id and key from valid mux.md URL", () => {
      const result = parseMuxMdUrl("https://mux.md/abc123#key456");
      expect(result).toEqual({ id: "abc123", key: "key456" });
    });

    it("should handle base64url characters in key", () => {
      const result = parseMuxMdUrl("https://mux.md/RQJe3#Fbbhosspt9q9Ig");
      expect(result).toEqual({ id: "RQJe3", key: "Fbbhosspt9q9Ig" });
    });

    it("should return null for URLs without hash", () => {
      expect(parseMuxMdUrl("https://mux.md/abc123")).toBeNull();
    });

    it("should return null for URLs with empty id", () => {
      expect(parseMuxMdUrl("https://mux.md/#key")).toBeNull();
    });

    it("should return null for invalid URLs", () => {
      expect(parseMuxMdUrl("not-a-url")).toBeNull();
    });
  });
});

describe("web_fetch tool", () => {
  // Integration test: fetch a real public URL
  itIntegration("should fetch and convert a real web page to markdown", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      // example.com is a stable, simple HTML page maintained by IANA
      url: "https://example.com",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.title).toContain("Example Domain");
      expect(result.url).toBe("https://example.com");
      // example.com mentions documentation examples
      expect(result.content).toContain("documentation");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  // Integration test: fetch plain text endpoint (not HTML)
  itIntegration("should fetch plain text content without HTML processing", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      // Cloudflare's trace endpoint returns plain text diagnostics
      url: "https://cloudflare.com/cdn-cgi/trace",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      // Should contain typical trace fields
      expect(result.content).toContain("fl=");
      expect(result.content).toContain("h=");
      expect(result.content).toContain("ip=");
      // Title should be the URL for plain text
      expect(result.title).toBe("https://cloudflare.com/cdn-cgi/trace");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  itIntegration("should handle DNS failure gracefully", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      // .invalid TLD is reserved and guaranteed to never resolve
      url: "https://this-domain-does-not-exist.invalid/page",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to fetch URL");
    }
  });

  it("should handle connection refused gracefully", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      // localhost on a random high port should refuse connection
      url: "http://127.0.0.1:59999/page",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to fetch URL");
    }
  });

  // Test with a local file served via file:// - tests HTML parsing without network
  it("should handle local HTML content via file:// URL", async () => {
    using testEnv = createTestWebFetchTool();

    // Create a test HTML file
    const htmlContent = `
<!DOCTYPE html>
<html>
<head><title>Local Test Page</title></head>
<body>
  <article>
    <h1>Test Heading</h1>
    <p>This is test content with <strong>bold</strong> and <em>italic</em> text.</p>
  </article>
</body>
</html>`;
    const htmlPath = path.join(testEnv.tempDir.path, "test.html");
    await fs.writeFile(htmlPath, htmlContent);

    const args: WebFetchToolArgs = {
      url: `file://${htmlPath}`,
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.title).toBe("Local Test Page");
      expect(result.content).toContain("Test Heading");
      expect(result.content).toContain("**bold**");
      expect(result.content).toContain("_italic_");
    }
  });

  it("should not treat non-mux.md URLs with fragments as mux.md shares", async () => {
    using testEnv = createTestWebFetchTool();

    const htmlContent = `
<!DOCTYPE html>
<html>
<head><title>Fragment Page</title></head>
<body>
  <article>
    <h1>Hello</h1>
    <p>This is a fragment test.</p>
  </article>
</body>
</html>`;
    const htmlPath = path.join(testEnv.tempDir.path, "fragment.html");
    await fs.writeFile(htmlPath, htmlContent);

    const args: WebFetchToolArgs = {
      url: `file://${htmlPath}#section1`,
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.title).toBe("Fragment Page");
      expect(result.content).toContain("This is a fragment test.");
    }
  });

  it("should truncate oversized output from local file", async () => {
    using testEnv = createTestWebFetchTool();

    // Create HTML that will produce content larger than WEB_FETCH_MAX_OUTPUT_BYTES
    const largeContent = "x".repeat(WEB_FETCH_MAX_OUTPUT_BYTES + 1000);
    const htmlContent = `
<!DOCTYPE html>
<html>
<head><title>Large Page</title></head>
<body><article><p>${largeContent}</p></article></body>
</html>`;
    const htmlPath = path.join(testEnv.tempDir.path, "large.html");
    await fs.writeFile(htmlPath, htmlContent);

    const args: WebFetchToolArgs = {
      url: `file://${htmlPath}`,
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content.length).toBeLessThanOrEqual(
        WEB_FETCH_MAX_OUTPUT_BYTES + 100 // Allow for truncation message
      );
      expect(result.content).toContain("[Content truncated]");
    }
  });

  it("should handle non-article HTML gracefully", async () => {
    using testEnv = createTestWebFetchTool();

    // Minimal HTML that Readability may not parse as an article
    const htmlContent = "<html><body><p>Just some text</p></body></html>";
    const htmlPath = path.join(testEnv.tempDir.path, "minimal.html");
    await fs.writeFile(htmlPath, htmlContent);

    const args: WebFetchToolArgs = {
      url: `file://${htmlPath}`,
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    // Readability may or may not parse this - the important thing is we don't crash
    expect(typeof result.success).toBe("boolean");
  });

  it("should handle empty file", async () => {
    using testEnv = createTestWebFetchTool();

    const htmlPath = path.join(testEnv.tempDir.path, "empty.html");
    await fs.writeFile(htmlPath, "");

    const args: WebFetchToolArgs = {
      url: `file://${htmlPath}`,
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Empty response");
    }
  });

  it("should handle missing file", async () => {
    using testEnv = createTestWebFetchTool();

    const args: WebFetchToolArgs = {
      url: `file://${testEnv.tempDir.path}/nonexistent.html`,
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to fetch URL");
    }
  });

  // Test HTTP error handling with body parsing
  itIntegration("should include HTTP status code in error for non-2xx responses", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      // httpbin.dev reliably returns the requested status code
      url: "https://httpbin.dev/status/404",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("HTTP 404");
    }
  });

  itIntegration("should detect Cloudflare challenge pages", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      // platform.openai.com is known to serve Cloudflare challenges
      url: "https://platform.openai.com",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Cloudflare");
      expect(result.error).toContain("JavaScript");
    }
  });

  // mux.md integration tests
  itIntegration("should handle expired/missing mux.md share links", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      // Non-existent share ID should return 404
      url: "https://mux.md/nonexistent123#somekey456",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("expired or not found");
    }
  });

  it("should return error for mux.md URLs without valid key format", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      // URL without hash (invalid mux.md format) - should fall through to normal fetch
      // which will fail to extract content from mux.md's HTML viewer
      url: "https://mux.md/someid",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    // Without the key fragment, it's treated as a normal URL fetch
    // The mux.md viewer page won't have extractable content
    expect(result.success).toBe(false);
  });

  itIntegration("should decrypt and return mux.md content correctly", async () => {
    using testEnv = createTestWebFetchTool();

    // Upload test content to mux.md
    const testContent = "# Test Heading\n\nThis is **test content** for web_fetch decryption.";
    const uploadResult = await uploadToMuxMd(
      testContent,
      { name: "test.md", type: "text/markdown", size: testContent.length },
      { expiresAt: new Date(Date.now() + 60000) }
    );

    try {
      // Fetch via web_fetch tool
      const args: WebFetchToolArgs = { url: uploadResult.url };
      const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe(testContent);
        expect(result.title).toBe("test.md");
        expect(result.url).toBe(uploadResult.url);
        expect(result.length).toBe(testContent.length);
      }
    } finally {
      // Clean up
      await deleteFromMuxMd(uploadResult.id, uploadResult.mutateKey);
    }
  });
});
