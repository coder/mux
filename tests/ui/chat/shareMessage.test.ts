/**
 * Integration tests for the mux.md message sharing feature.
 *
 * Tests cover:
 * - End-to-end encrypted upload to mux.md
 * - URL format validation
 * - Content can be retrieved and decrypted
 * - Delete functionality
 */

import "../dom";
import { shouldRunIntegrationTests } from "../../testUtils";
import { uploadToMuxMd, deleteFromMuxMd, getMuxMdBaseUrl } from "../../../src/common/lib/muxMd";

if (process.env.CI && typeof jest !== "undefined" && jest.retryTimes) {
  jest.retryTimes(2, { logErrorsBeforeRetry: true });
}

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// ═══════════════════════════════════════════════════════════════════════════════
// MUX.MD UPLOAD TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describeIntegration("mux.md sharing (upload integration)", () => {
  test("should upload encrypted content and return valid URL", async () => {
    const testContent =
      "# Test Message\n\nThis is a test message for sharing.\n\n```typescript\nconst x = 42;\n```";

    const result = await uploadToMuxMd(testContent, {
      name: "message.md",
      type: "text/markdown",
      size: new TextEncoder().encode(testContent).length,
      model: "test-model",
      thinking: "medium",
    });

    // Verify the URL format: https://mux.md/{id}#{key}
    expect(result.url).toMatch(/^https:\/\/mux\.md\/[A-Za-z0-9]+#[A-Za-z0-9_-]+$/);
    expect(result.id).toMatch(/^[A-Za-z0-9]+$/);
    expect(result.key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.mutateKey).toBeTruthy();

    // Verify URL contains the id and key
    expect(result.url).toContain(result.id);
    expect(result.url).toContain(result.key);
  }, 30_000);

  test("should generate unique URLs for each upload", async () => {
    const content = "Test content for uniqueness check";

    // Run both uploads concurrently to reduce wall-clock time and avoid flakiness
    // from sequential network latency to the external mux.md service.
    const [result1, result2] = await Promise.all([
      uploadToMuxMd(content, {
        name: "message.md",
        type: "text/markdown",
        size: content.length,
      }),
      uploadToMuxMd(content, {
        name: "message.md",
        type: "text/markdown",
        size: content.length,
      }),
    ]);

    // Each upload should generate unique id, key, and mutateKey
    expect(result1.id).not.toBe(result2.id);
    expect(result1.key).not.toBe(result2.key);
    expect(result1.mutateKey).not.toBe(result2.mutateKey);
  }, 30_000);

  test("should handle special characters in content", async () => {
    const contentWithSpecialChars = `# Special Characters Test
    
Unicode: 你好世界 🎉 émojis
Code: \`const x = { a: 1, b: "test" };\`
Markdown: **bold** _italic_ [link](https://example.com)
HTML entities: &amp; &lt; &gt;
`;

    const result = await uploadToMuxMd(contentWithSpecialChars, {
      name: "special.md",
      type: "text/markdown",
      size: new TextEncoder().encode(contentWithSpecialChars).length,
    });

    expect(result.url).toMatch(/^https:\/\/mux\.md\/[A-Za-z0-9]+#[A-Za-z0-9_-]+$/);
  }, 30_000);

  test("should include model metadata in upload", async () => {
    const content = "Test with model metadata";

    const result = await uploadToMuxMd(content, {
      name: "message.md",
      type: "text/markdown",
      size: content.length,
      model: "claude-sonnet-4-20250514",
      thinking: "high",
    });

    // Upload should succeed - metadata is encrypted client-side
    expect(result.url).toBeTruthy();
    expect(result.id).toBeTruthy();
  }, 30_000);

  test("should successfully delete uploaded content using mutateKey", async () => {
    const content = "Content to be deleted";

    // Upload first
    const result = await uploadToMuxMd(content, {
      name: "delete-test.md",
      type: "text/markdown",
      size: content.length,
    });

    expect(result.id).toBeTruthy();
    expect(result.mutateKey).toBeTruthy();

    // Delete should complete without throwing
    await expect(deleteFromMuxMd(result.id, result.mutateKey)).resolves.not.toThrow();

    // Verify the content is no longer accessible (fetch returns 404).
    // Use getMuxMdBaseUrl() to respect the MUX_MD_URL_OVERRIDE env var,
    // and consume the response body to avoid leaking the TCP connection
    // (which causes "worker process has failed to exit gracefully" warnings).
    const response = await fetch(`${getMuxMdBaseUrl()}/${result.id}`);
    await response.body?.cancel();
    expect(response.status).toBe(404);
    // Higher timeout: this test makes 3 sequential HTTP calls to an external
    // service (upload → delete → verification fetch). 30s is tight when the
    // service is slow.
  }, 60_000);
});
