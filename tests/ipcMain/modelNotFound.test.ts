import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "./setup";
import { sendMessageWithModel, createEventCollector, waitFor, modelString } from "./helpers";
import { IPC_CHANNELS } from "../../src/common/constants/ipc-constants";
import type { Result } from "../../src/common/types/result";
import type { SendMessageError } from "../../src/common/types/errors";
import type { StreamErrorMessage } from "../../src/common/types/ipc";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
}

describeIntegration("IpcMain model_not_found error handling", () => {
  test.concurrent(
    "should classify Anthropic 404 as model_not_found (not retryable)",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Send a message with a non-existent model
        // Anthropic returns 404 with error.type === 'not_found_error'
        void sendMessageWithModel(
          env.mockIpcRenderer,
          workspaceId,
          "Hello",
          modelString("anthropic", "invalid-model-that-does-not-exist-xyz123")
        );

        // Collect events to verify error classification
        const collector = createEventCollector(env.sentEvents, workspaceId);
        await waitFor(() => {
          collector.collect();
          return collector.getEvents().some((e) => "type" in e && e.type === "stream-error");
        }, 10000);

        const events = collector.getEvents();
        const errorEvent = events.find((e) => "type" in e && e.type === "stream-error") as
          | StreamErrorMessage
          | undefined;

        expect(errorEvent).toBeDefined();

        // Bug: Error should be classified as 'model_not_found', not 'api' or 'unknown'
        // This ensures it's marked as non-retryable in retryEligibility.ts
        expect(errorEvent?.errorType).toBe("model_not_found");
      } finally {
        await cleanup();
      }
    },
    30000 // 30s timeout
  );

  test.concurrent(
    "should classify OpenAI 400 model_not_found as model_not_found (not retryable)",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("openai");
      try {
        // Send a message with a non-existent model
        // OpenAI returns 400 with error.code === 'model_not_found'
        void sendMessageWithModel(
          env.mockIpcRenderer,
          workspaceId,
          "Hello",
          modelString("openai", "gpt-nonexistent-model-xyz123")
        );

        // Collect events to verify error classification
        const collector = createEventCollector(env.sentEvents, workspaceId);
        await waitFor(() => {
          collector.collect();
          return collector.getEvents().some((e) => "type" in e && e.type === "stream-error");
        }, 10000);

        const events = collector.getEvents();
        const errorEvent = events.find((e) => "type" in e && e.type === "stream-error") as
          | StreamErrorMessage
          | undefined;

        expect(errorEvent).toBeDefined();

        // Bug: Error should be classified as 'model_not_found', not 'api' or 'unknown'
        expect(errorEvent?.errorType).toBe("model_not_found");
      } finally {
        await cleanup();
      }
    },
    30000 // 30s timeout
  );
});
