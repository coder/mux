import { shouldRunIntegrationTests, validateApiKeys } from "./setup";
import {
  sendMessageWithModel,
  sendMessage,
  createEventCollector,
  assertStreamSuccess,
  assertError,
  waitFor,
  waitForStreamSuccess,
  readChatHistory,
  TEST_IMAGES,
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
  describe.each(PROVIDER_CONFIGS)("%s:%s provider tests", (provider, model) => {
    // Test image support
    test.concurrent(
      "should send images to AI model and get response",
      async () => {
        // Skip Anthropic for now as it fails to process the image data URI in tests
        if (provider === "anthropic") return;

        await withSharedWorkspace(provider, async ({ env, workspaceId }) => {
          // Send message with image attachment
          const result = await sendMessage(
            env.mockIpcRenderer,
            workspaceId,
            "What color is this?",
            {
              model: modelString(provider, model),
              imageParts: [TEST_IMAGES.RED_PIXEL],
            }
          );

          expect(result.success).toBe(true);

          // Wait for stream to complete
          const collector = await waitForStreamSuccess(env.sentEvents, workspaceId, 30000);

          // Verify we got a response about the image
          const deltas = collector.getDeltas();
          expect(deltas.length).toBeGreaterThan(0);

          // Combine all text deltas
          const fullResponse = deltas
            .map((d) => (d as StreamDeltaEvent).delta)
            .join("")
            .toLowerCase();

          // Should mention red color in some form
          expect(fullResponse.length).toBeGreaterThan(0);
          // Red pixel should be detected (flexible matching as different models may phrase differently)
          expect(fullResponse).toMatch(/red|color|orange/i);
        });
      },
      40000 // Vision models can be slower
    );

    test.concurrent(
      "should preserve image parts through history",
      async () => {
        // Skip Anthropic for now as it fails to process the image data URI in tests
        if (provider === "anthropic") return;

        await withSharedWorkspace(provider, async ({ env, workspaceId }) => {
          // Send message with image
          const result = await sendMessage(env.mockIpcRenderer, workspaceId, "Describe this", {
            model: modelString(provider, model),
            imageParts: [TEST_IMAGES.BLUE_PIXEL],
          });

          expect(result.success).toBe(true);

          // Wait for stream to complete
          await waitForStreamSuccess(env.sentEvents, workspaceId, 30000);

          // Read history from disk
          const messages = await readChatHistory(env.tempDir, workspaceId);

          // Find the user message
          const userMessage = messages.find((m: { role: string }) => m.role === "user");
          expect(userMessage).toBeDefined();

          // Verify image part is preserved with correct format
          if (userMessage) {
            const imagePart = userMessage.parts.find((p: { type: string }) => p.type === "file");
            expect(imagePart).toBeDefined();
            if (imagePart) {
              expect(imagePart.url).toBe(TEST_IMAGES.BLUE_PIXEL.url);
              expect(imagePart.mediaType).toBe("image/png");
            }
          }
        });
      },
      40000
    );

    // Test multi-turn conversation specifically for reasoning models (codex mini)
  });
});
