import { shouldRunIntegrationTests } from "../../../../tests/testUtils";

import { describe, it, expect } from "bun:test";
import { createWebFetchTool } from "./web_fetch";
import type { WebFetchToolArgs, WebFetchToolResult } from "@/common/types/tools";
import { WEB_FETCH_MAX_OUTPUT_BYTES } from "@/common/constants/toolLimits";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import * as fs from "fs/promises";
import * as path from "path";

import type { ToolCallOptions } from "ai";

// ToolCallOptions stub for testing

const itInternet = shouldRunIntegrationTests() ? it : it.skip;
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

describe("web_fetch tool", () => {
  // Integration test: fetch a real public URL
  itInternet("should fetch and convert a real web page to markdown", async () => {
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
  itInternet("should fetch plain text content without HTML processing", async () => {
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

  itInternet("should handle DNS failure gracefully", async () => {
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
  it("should include HTTP status code in error for non-2xx responses", async () => {
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

  it("should detect Cloudflare challenge pages", async () => {
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
});
