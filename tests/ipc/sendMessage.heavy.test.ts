/**
 * sendMessage heavy/load integration tests.
 *
 * Tests heavy workload scenarios:
 * - Large conversation history handling
 * - Auto-truncation behavior
 * - Context limit error handling
 */

import { shouldRunIntegrationTests, validateApiKeys } from "./setup";
import { sendMessageWithModel, modelString, createStreamCollector } from "./helpers";
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
  validateApiKeys(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
}

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);

describeIntegration("sendMessage heavy/load tests", () => {
  configureTestRetries(3);

  describe("OpenAI auto truncation", () => {
    const provider = "openai";
    const model = KNOWN_MODELS.GPT_MINI.providerModelId;

    test.concurrent(
      "respects disableAutoTruncation flag",
      async () => {
        await withSharedWorkspace(provider, async ({ env, workspaceId, collector }) => {
          // Build up large conversation history to exceed context limit
          // This approach is model-agnostic - it keeps sending until we've built up enough history
          const largeMessage = "x".repeat(50_000);
          for (let i = 0; i < 10; i++) {
            await sendMessageWithModel(
              env,
              workspaceId,
              `Message ${i}: ${largeMessage}`,
              modelString(provider, model)
            );
            await collector.waitForEvent("stream-end", 30000);
            collector.clear();
          }

          // Now send a new message with auto-truncation disabled - should trigger real API error
          const result = await sendMessageWithModel(
            env,
            workspaceId,
            "This should trigger a context error",
            modelString(provider, model),
            {
              providerOptions: {
                openai: {
                  disableAutoTruncation: true,
                },
              },
            }
          );

          // IPC call itself should succeed (errors come through stream events)
          expect(result.success).toBe(true);

          // Wait for stream-error event from the real OpenAI API
          const errorEvent = await collector.waitForEvent("stream-error", 30000);
          expect(errorEvent).toBeDefined();

          if (errorEvent?.type === "stream-error") {
            const errorStr = errorEvent.error.toLowerCase();
            // OpenAI will return an error about context/token limits
            expect(
              errorStr.includes("context") ||
                errorStr.includes("length") ||
                errorStr.includes("exceed") ||
                errorStr.includes("token") ||
                errorStr.includes("maximum")
            ).toBe(true);
          }

          // Phase 2: Send message with auto-truncation enabled (should succeed)
          collector.clear();
          const successResult = await sendMessageWithModel(
            env,
            workspaceId,
            "This should succeed with auto-truncation",
            modelString(provider, model)
            // disableAutoTruncation defaults to false (auto-truncation enabled)
          );

          expect(successResult.success).toBe(true);
          await collector.waitForEvent("stream-end", 30000);
        });
      },
      180000 // 3 minute timeout for building large history and API calls
    );
  });

  describe("context limit handling", () => {
    test.concurrent(
      "should handle very long single messages",
      async () => {
        await withSharedWorkspace("openai", async ({ env, workspaceId, collector }) => {
          // Send a very long message
          const longContent = "This is a test message. ".repeat(1000);
          const result = await sendMessageWithModel(
            env,
            workspaceId,
            longContent,
            modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId)
          );

          expect(result.success).toBe(true);

          // Should complete or error gracefully
          await Promise.race([
            collector.waitForEvent("stream-end", 30000),
            collector.waitForEvent("stream-error", 30000),
          ]);

          // Either way, should have received some response
          const events = collector.getEvents();
          expect(events.length).toBeGreaterThan(0);
        });
      },
      45000
    );
  });
});
