import { shouldRunIntegrationTests, validateApiKeys } from "./setup";
import {
  sendMessageWithModel,
  sendMessage,
  createEventCollector,
  assertStreamSuccess,
  assertError,
  waitFor,
  buildLargeHistory,
  waitForStreamSuccess,
  readChatHistory,
  modelString,
  configureTestRetries,
} from "./helpers";
import { createSharedRepo, cleanupSharedRepo, withSharedWorkspace } from "./sendMessageTestHelpers";
import type { StreamDeltaEvent } from "../../src/common/types/stream";
import { IPC_CHANNELS } from "../../src/common/constants/ipc-constants";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
}

import { KNOWN_MODELS } from "@/common/constants/knownModels";

// Test both providers with their respective models
const PROVIDER_CONFIGS: Array<[string, string]> = [
  ["openai", KNOWN_MODELS.GPT_MINI.providerModelId],
  ["anthropic", KNOWN_MODELS.SONNET.providerModelId],
];

// Integration test timeout guidelines:
// - Individual tests should complete within 10 seconds when possible
// - Use tight timeouts (5-10s) for event waiting to fail fast
// - Longer running tests (tool calls, multiple edits) can take up to 30s
// - Test timeout values (in describe/test) should be 2-3x the expected duration

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);
describeIntegration("IpcMain sendMessage integration tests", () => {
  configureTestRetries(3);

  // Run tests for each provider concurrently
  describeIntegration("OpenAI auto truncation integration", () => {
    const provider = "openai";
    const model = "gpt-4o-mini";

    test.concurrent(
      "respects disableAutoTruncation flag",
      async () => {
        await withSharedWorkspace(provider, async ({ env, workspaceId }) => {
          // Phase 1: Build up large conversation history to exceed context limit
          // Use ~80 messages (4M chars total) to ensure we hit the limit
          await buildLargeHistory(workspaceId, env.config, {
            messageSize: 50_000,
            messageCount: 80,
          });

          // Now send a new message with auto-truncation disabled - should trigger error
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "This should trigger a context error",
            modelString(provider, model),
            {
              providerOptions: {
                openai: {
                  disableAutoTruncation: true,
                  forceContextLimitError: true,
                },
              },
            }
          );

          // IPC call itself should succeed (errors come through stream events)
          expect(result.success).toBe(true);

          // Wait for either stream-end or stream-error
          const collector = createEventCollector(env.sentEvents, workspaceId);
          await Promise.race([
            collector.waitForEvent("stream-end", 10000),
            collector.waitForEvent("stream-error", 10000),
          ]);

          // Should have received error event with context exceeded error
          expect(collector.hasError()).toBe(true);

          // Check that error message contains context-related keywords
          const errorEvents = collector
            .getEvents()
            .filter((e) => "type" in e && e.type === "stream-error");
          expect(errorEvents.length).toBeGreaterThan(0);

          const errorEvent = errorEvents[0];
          if (errorEvent && "error" in errorEvent) {
            const errorStr = String(errorEvent.error).toLowerCase();
            expect(
              errorStr.includes("context") ||
                errorStr.includes("length") ||
                errorStr.includes("exceed") ||
                errorStr.includes("token")
            ).toBe(true);
          }

          // Phase 2: Send message with auto-truncation enabled (should succeed)
          env.sentEvents.length = 0;
          const successResult = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "This should succeed with auto-truncation",
            modelString(provider, model)
            // disableAutoTruncation defaults to false (auto-truncation enabled)
          );

          expect(successResult.success).toBe(true);
          const successCollector = createEventCollector(env.sentEvents, workspaceId);
          await successCollector.waitForEvent("stream-end", 30000);
          assertStreamSuccess(successCollector);
        });
      },
      60000 // 1 minute timeout (much faster since we don't make many API calls)
    );
  });
});
