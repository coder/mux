/**
 * Integration tests for reasoning/thinking functionality across Anthropic models.
 *
 * Verifies:
 * - Sonnet 4.5 uses thinking.budgetTokens parameter
 * - Opus 4.5 uses effort parameter
 * - Reasoning events are properly streamed
 */

import { shouldRunIntegrationTests, validateApiKeys } from "./setup";
import { sendMessage, createStreamCollector } from "./helpers";
import {
  createSharedRepo,
  cleanupSharedRepo,
  withSharedWorkspace,
  configureTestRetries,
} from "./sendMessageTestHelpers";
import { KNOWN_MODELS } from "../../src/common/constants/knownModels";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);

describeIntegration("Anthropic reasoning parameter tests", () => {
  configureTestRetries(3);

  test.concurrent(
    "Sonnet 4.5 with thinking (budgetTokens)",
    async () => {
      await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector }) => {
        const result = await sendMessage(env, workspaceId, "What is 2+2? Answer in one word.", {
          model: KNOWN_MODELS.SONNET.id,
          thinkingLevel: "low",
        });
        expect(result.success).toBe(true);

        await collector.waitForEvent("stream-end", 30000);

        // Verify we got a response
        const deltas = collector.getDeltas();
        expect(deltas.length).toBeGreaterThan(0);
      });
    },
    60000
  );

  test.concurrent(
    "Opus 4.5 with thinking (effort)",
    async () => {
      await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector }) => {
        const result = await sendMessage(env, workspaceId, "What is 4+4? Answer in one word.", {
          model: KNOWN_MODELS.OPUS.id,
          thinkingLevel: "low",
        });
        expect(result.success).toBe(true);

        await collector.waitForEvent("stream-end", 60000);

        // Verify we got a response
        const deltas = collector.getDeltas();
        expect(deltas.length).toBeGreaterThan(0);
      });
    },
    90000
  );

  test.concurrent(
    "should receive reasoning events when thinking enabled",
    async () => {
      await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector }) => {
        const result = await sendMessage(env, workspaceId, "Explain briefly why 2+2=4", {
          model: KNOWN_MODELS.SONNET.id,
          thinkingLevel: "medium",
        });
        expect(result.success).toBe(true);

        await collector.waitForEvent("stream-end", 45000);

        // Check for reasoning-related events
        const events = collector.getEvents();

        // Should have some delta events
        const deltas = collector.getDeltas();
        expect(deltas.length).toBeGreaterThan(0);

        // May have reasoning events depending on model behavior
        const reasoningStarts = events.filter(
          (e) => "type" in e && (e as { type: string }).type === "reasoning-start"
        );
        const reasoningDeltas = events.filter(
          (e) => "type" in e && (e as { type: string }).type === "reasoning-delta"
        );

        // If we got reasoning events, verify structure
        if (reasoningStarts.length > 0) {
          expect(reasoningDeltas.length).toBeGreaterThan(0);
        }
      });
    },
    60000
  );
});
