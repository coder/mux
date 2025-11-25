/**
 * Integration tests for reasoning/thinking functionality across Anthropic models
 *
 * These tests verify that:
 * 1. Opus 4.5 uses the `effort` parameter correctly
 * 2. Sonnet 4.5 uses the `thinking.budgetTokens` parameter correctly
 * 3. Both models can successfully stream responses with reasoning enabled
 *
 * This prevents regressions where the wrong parameter is used for a model.
 */

import { shouldRunIntegrationTests, validateApiKeys } from "./setup";
import {
  sendMessage,
  assertStreamSuccess,
  waitForStreamSuccess,
  configureTestRetries,
} from "./helpers";
import { createSharedRepo, cleanupSharedRepo, withSharedWorkspace } from "./sendMessageTestHelpers";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

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

  describe("Sonnet 4.5 (thinking.budgetTokens)", () => {
    test.concurrent(
      "should successfully send message with low thinking level",
      async () => {
        await withSharedWorkspace("anthropic", async ({ env, workspaceId }) => {
          // Send a message with low thinking level
          // Sonnet 4.5 should use thinking.budgetTokens=4000
          const result = await sendMessage(
            env.mockIpcRenderer,
            workspaceId,
            "What is 2+2? Answer in one word.",
            {
              model: KNOWN_MODELS.SONNET.id,
              thinkingLevel: "low",
            }
          );

          expect(result.success).toBe(true);

          // Wait for stream to complete
          const collector = await waitForStreamSuccess(env.sentEvents, workspaceId, 30000);

          // Verify we got a successful response
          assertStreamSuccess(collector);

          // Verify we received deltas (actual response content)
          const deltas = collector.getDeltas();
          expect(deltas.length).toBeGreaterThan(0);

          // Verify reasoning occurred (Sonnet 4.5 with thinking enabled should produce reasoning)
          const events = collector.getEvents();
          const hasReasoning = events.some((e) => "type" in e && e.type === "reasoning-delta");
          expect(hasReasoning).toBe(true);
        });
      },
      60000
    );

    test.concurrent(
      "should successfully send message with medium thinking level",
      async () => {
        await withSharedWorkspace("anthropic", async ({ env, workspaceId }) => {
          // Send a message with medium thinking level
          // Sonnet 4.5 should use thinking.budgetTokens=10000
          const result = await sendMessage(
            env.mockIpcRenderer,
            workspaceId,
            "What is 3+3? Answer in one word.",
            {
              model: KNOWN_MODELS.SONNET.id,
              thinkingLevel: "medium",
            }
          );

          expect(result.success).toBe(true);

          // Wait for stream to complete
          const collector = await waitForStreamSuccess(env.sentEvents, workspaceId, 30000);

          assertStreamSuccess(collector);

          const deltas = collector.getDeltas();
          expect(deltas.length).toBeGreaterThan(0);
        });
      },
      60000
    );
  });

  describe("Opus 4.5 (effort parameter)", () => {
    test.concurrent(
      "should successfully send message with low effort level",
      async () => {
        await withSharedWorkspace("anthropic", async ({ env, workspaceId }) => {
          // Send a message with low thinking level
          // Opus 4.5 should use effort="low" (NOT thinking.budgetTokens)
          const result = await sendMessage(
            env.mockIpcRenderer,
            workspaceId,
            "What is 4+4? Answer in one word.",
            {
              model: KNOWN_MODELS.OPUS.id,
              thinkingLevel: "low",
            }
          );

          expect(result.success).toBe(true);

          // Wait for stream to complete
          const collector = await waitForStreamSuccess(env.sentEvents, workspaceId, 60000);

          // Verify we got a successful response
          assertStreamSuccess(collector);

          // Verify we received deltas (actual response content)
          const deltas = collector.getDeltas();
          expect(deltas.length).toBeGreaterThan(0);
        });
      },
      90000 // Opus is slower, give more time
    );

    test.concurrent(
      "should successfully send message with medium effort level",
      async () => {
        await withSharedWorkspace("anthropic", async ({ env, workspaceId }) => {
          // Send a message with medium thinking level
          // Opus 4.5 should use effort="medium"
          const result = await sendMessage(
            env.mockIpcRenderer,
            workspaceId,
            "What is 5+5? Answer in one word.",
            {
              model: KNOWN_MODELS.OPUS.id,
              thinkingLevel: "medium",
            }
          );

          expect(result.success).toBe(true);

          // Wait for stream to complete
          const collector = await waitForStreamSuccess(env.sentEvents, workspaceId, 60000);

          assertStreamSuccess(collector);

          const deltas = collector.getDeltas();
          expect(deltas.length).toBeGreaterThan(0);
        });
      },
      90000
    );

    test.concurrent(
      "should successfully send message with thinking off",
      async () => {
        await withSharedWorkspace("anthropic", async ({ env, workspaceId }) => {
          // Send a message with thinking off
          // Opus 4.5 should NOT include effort parameter
          const result = await sendMessage(
            env.mockIpcRenderer,
            workspaceId,
            "What is 6+6? Answer in one word.",
            {
              model: KNOWN_MODELS.OPUS.id,
              thinkingLevel: "off",
            }
          );

          expect(result.success).toBe(true);

          // Wait for stream to complete
          const collector = await waitForStreamSuccess(env.sentEvents, workspaceId, 60000);

          assertStreamSuccess(collector);

          const deltas = collector.getDeltas();
          expect(deltas.length).toBeGreaterThan(0);

          // With thinking off, we should NOT have reasoning events
          const events = collector.getEvents();
          const hasReasoning = events.some((e) => "type" in e && e.type === "reasoning-delta");
          expect(hasReasoning).toBe(false);
        });
      },
      90000
    );
  });
});
