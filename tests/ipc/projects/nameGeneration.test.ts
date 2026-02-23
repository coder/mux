/**
 * Integration test for workspace name generation with real LLM.
 *
 * Verifies that name generation works end-to-end:
 * - Calls the real AI provider
 * - Returns valid workspace identity (name + title)
 * - Model selection fallback works correctly
 */

import { shouldRunIntegrationTests } from "../../testUtils";
import { createTestEnvironment, cleanupTestEnvironment, type TestEnvironment } from "../setup";

// Skip if integration tests are disabled (requires real API keys)
const describeIfIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIfIntegration("Name generation with real LLM", () => {
  let env: TestEnvironment;

  beforeAll(async () => {
    env = await createTestEnvironment();
    // Don't enable mock mode - we want real LLM calls
  }, 30_000);

  afterAll(async () => {
    await cleanupTestEnvironment(env);
  }, 30_000);

  it("generates workspace name and title from user message", async () => {
    const result = await env.orpc.nameGeneration.generate({
      message: "Fix the sidebar layout bug where items overflow on mobile",
      candidates: ["anthropic:claude-haiku-4-5", "openai:gpt-5.2"],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Name should be git-safe (lowercase, hyphens, no spaces)
    expect(result.data.name).toMatch(/^[a-z0-9-]+$/);
    // Name should have a suffix (format: area-xxxx)
    expect(result.data.name).toMatch(/-[a-z0-9]{4}$/);
    // Name shouldn't be too long
    expect(result.data.name.length).toBeLessThanOrEqual(30);

    // Title should be human-readable
    expect(result.data.title.length).toBeGreaterThan(0);
    expect(result.data.title.length).toBeLessThanOrEqual(60);

    // Should report which model was used
    expect(result.data.modelUsed).toBeTruthy();
    expect(result.data.modelUsed).toContain(":");
  }, 30_000);

  it("handles empty message gracefully", async () => {
    const result = await env.orpc.nameGeneration.generate({
      message: "",
      candidates: ["anthropic:claude-haiku-4-5", "openai:gpt-5.2"],
    });

    // Empty message should fail or return minimal result
    // The exact behavior depends on implementation
    if (result.success) {
      expect(result.data.name).toBeTruthy();
    } else {
      expect(result.error).toBeTruthy();
    }
  }, 30_000);

  it("generates different names for different messages", async () => {
    const candidates = ["anthropic:claude-haiku-4-5", "openai:gpt-5.2"];
    const [result1, result2] = await Promise.all([
      env.orpc.nameGeneration.generate({
        message: "Add user authentication with OAuth",
        candidates,
      }),
      env.orpc.nameGeneration.generate({
        message: "Refactor database connection pooling",
        candidates,
      }),
    ]);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    if (result1.success && result2.success) {
      // Names should be different (very unlikely to collide)
      expect(result1.data.name).not.toBe(result2.data.name);
      // Titles should be different
      expect(result1.data.title).not.toBe(result2.data.title);
    }
  }, 60_000);
});
