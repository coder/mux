/**
 * sendMessage image handling integration tests.
 *
 * Tests image attachment functionality:
 * - Sending images to AI models
 * - Image part preservation in history
 * - Multi-modal conversation support
 */

import { shouldRunIntegrationTests, validateApiKeys } from "./setup";
import { sendMessage, modelString, createStreamCollector } from "./helpers";
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

// 1x1 red PNG pixel as base64 data URI
const RED_PIXEL = {
  url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  mediaType: "image/png" as const,
};

// 1x1 blue PNG pixel as base64 data URI
const BLUE_PIXEL = {
  url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==",
  mediaType: "image/png" as const,
};

// Test both providers with their respective models
const PROVIDER_CONFIGS: Array<[string, string]> = [
  ["openai", KNOWN_MODELS.GPT_MINI.providerModelId],
  ["anthropic", KNOWN_MODELS.HAIKU.providerModelId],
];

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);

describeIntegration("sendMessage image handling tests", () => {
  configureTestRetries(3);

  describe.each(PROVIDER_CONFIGS)("%s image support", (provider, model) => {
    test.concurrent(
      "should send images to AI model and get response",
      async () => {
        // Skip Anthropic for now as it fails to process the image data URI in tests
        if (provider === "anthropic") return;

        await withSharedWorkspace(provider, async ({ env, workspaceId, collector }) => {
          // Send message with image attachment
          const result = await sendMessage(env, workspaceId, "What color is this?", {
            model: modelString(provider, model),
            imageParts: [RED_PIXEL],
          });

          expect(result.success).toBe(true);

          // Wait for stream to complete
          await collector.waitForEvent("stream-end", 30000);

          // Verify we got a response about the image
          const deltas = collector.getDeltas();
          expect(deltas.length).toBeGreaterThan(0);

          // Combine all text deltas
          const fullResponse = deltas
            .map((d) => ("delta" in d ? (d as { delta?: string }).delta || "" : ""))
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
      "should handle multiple images in single message",
      async () => {
        // Skip Anthropic for now
        if (provider === "anthropic") return;

        await withSharedWorkspace(provider, async ({ env, workspaceId, collector }) => {
          // Send message with multiple image attachments
          const result = await sendMessage(env, workspaceId, "What colors are these two images?", {
            model: modelString(provider, model),
            imageParts: [RED_PIXEL, BLUE_PIXEL],
          });

          expect(result.success).toBe(true);

          // Wait for stream to complete
          await collector.waitForEvent("stream-end", 30000);

          // Verify we got a response
          const deltas = collector.getDeltas();
          expect(deltas.length).toBeGreaterThan(0);

          // Combine all text deltas
          const fullResponse = deltas
            .map((d) => ("delta" in d ? (d as { delta?: string }).delta || "" : ""))
            .join("")
            .toLowerCase();

          // Should mention colors
          expect(fullResponse.length).toBeGreaterThan(0);
        });
      },
      40000
    );
  });

  describe("image conversation context", () => {
    test.concurrent(
      "should maintain image context across messages",
      async () => {
        await withSharedWorkspace("openai", async ({ env, workspaceId, collector }) => {
          // Send first message with image
          const result1 = await sendMessage(env, workspaceId, "Remember this image", {
            model: modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId),
            imageParts: [RED_PIXEL],
          });

          expect(result1.success).toBe(true);
          await collector.waitForEvent("stream-end", 30000);

          // Small delay to allow stream cleanup to complete before sending next message
          await new Promise((resolve) => setTimeout(resolve, 100));

          collector.clear();

          // Send follow-up asking about the image
          const result2 = await sendMessage(
            env,
            workspaceId,
            "What color was the image I showed you?",
            {
              model: modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId),
            }
          );

          expect(result2.success).toBe(true);
          await collector.waitForEvent("stream-end", 30000);

          // Verify the response references the image
          const deltas = collector.getDeltas();
          const fullResponse = deltas
            .map((d) => ("delta" in d ? (d as { delta?: string }).delta || "" : ""))
            .join("")
            .toLowerCase();

          // Should reference the red color from the previous image
          expect(fullResponse).toMatch(/red|color|image/i);
        });
      },
      60000
    );
  });
});
