import * as fs from "fs/promises";
import * as path from "path";
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
  describe.each(PROVIDER_CONFIGS)("%s:%s provider tests", (provider, model) => {
    test.concurrent(
      "should reject empty message (use interruptStream instead)",
      async () => {
        await withSharedWorkspace(provider, async ({ env, workspaceId }) => {
          // Send empty message without any active stream
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "",
            modelString(provider, model)
          );

          // Should fail - empty messages not allowed
          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error.type).toBe("unknown");
            if (result.error.type === "unknown") {
              expect(result.error.raw).toContain("Empty message not allowed");
            }
          }

          // Should not have created any stream events
          const collector = createEventCollector(env.sentEvents, workspaceId);
          collector.collect();

          const streamEvents = collector
            .getEvents()
            .filter((e) => "type" in e && e.type?.startsWith("stream-"));
          expect(streamEvents.length).toBe(0);
        });
      },
      15000
    );

    test.concurrent("should return error when model is not provided", async () => {
      await withSharedWorkspace(provider, async ({ env, workspaceId }) => {
        // Send message without model
        const result = await sendMessage(
          env.mockIpcRenderer,
          workspaceId,
          "Hello",
          {} as { model: string }
        );

        // Should fail with appropriate error
        assertError(result, "unknown");
        if (!result.success && result.error.type === "unknown") {
          expect(result.error.raw).toContain("No model specified");
        }
      });
    });

    test.concurrent("should return error for invalid model string", async () => {
      await withSharedWorkspace(provider, async ({ env, workspaceId }) => {
        // Send message with invalid model format
        const result = await sendMessage(env.mockIpcRenderer, workspaceId, "Hello", {
          model: "invalid-format",
        });

        // Should fail with invalid_model_string error
        assertError(result, "invalid_model_string");
      });
    });

    test.each(PROVIDER_CONFIGS)(
      "%s should return stream error when model does not exist",
      async (provider) => {
        await withSharedWorkspace(provider, async ({ env, workspaceId }) => {
          // Use a clearly non-existent model name
          const nonExistentModel = "definitely-not-a-real-model-12345";
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Hello, world!",
            modelString(provider, nonExistentModel)
          );

          // IPC call should succeed (errors come through stream events)
          expect(result.success).toBe(true);

          // Wait for stream-error event
          const collector = createEventCollector(env.sentEvents, workspaceId);
          const errorEvent = await collector.waitForEvent("stream-error", 10000);

          // Should have received a stream-error event
          expect(errorEvent).toBeDefined();
          expect(collector.hasError()).toBe(true);

          // Verify error message is the enhanced user-friendly version
          if (errorEvent && "error" in errorEvent) {
            const errorMsg = String(errorEvent.error);
            // Should have the enhanced error message format
            expect(errorMsg).toContain("definitely-not-a-real-model-12345");
            expect(errorMsg).toContain("does not exist or is not available");
          }

          // Verify error type is properly categorized
          if (errorEvent && "errorType" in errorEvent) {
            expect(errorEvent.errorType).toBe("model_not_found");
          }
        });
      }
    );
  });

  // Token limit error handling tests
  describe("token limit error handling", () => {
    test.each(PROVIDER_CONFIGS)(
      "%s should return error when accumulated history exceeds token limit",
      async (provider, model) => {
        await withSharedWorkspace(provider, async ({ env, workspaceId }) => {
          // Build up large conversation history to exceed context limits
          // Different providers have different limits:
          // - Anthropic: 200k tokens → need ~40 messages of 50k chars (2M chars total)
          // - OpenAI: varies by model, use ~80 messages (4M chars total) to ensure we hit the limit
          await buildLargeHistory(workspaceId, env.config, {
            messageSize: 50_000,
            messageCount: provider === "anthropic" ? 40 : 80,
          });

          // Now try to send a new message - should trigger token limit error
          // due to accumulated history
          // Disable auto-truncation to force context error
          const sendOptions =
            provider === "openai"
              ? {
                  providerOptions: {
                    openai: {
                      disableAutoTruncation: true,
                      forceContextLimitError: true,
                    },
                  },
                }
              : undefined;
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "What is the weather?",
            modelString(provider, model),
            sendOptions
          );

          // IPC call itself should succeed (errors come through stream events)
          expect(result.success).toBe(true);

          // Wait for either stream-end or stream-error
          const collector = createEventCollector(env.sentEvents, workspaceId);
          await Promise.race([
            collector.waitForEvent("stream-end", 10000),
            collector.waitForEvent("stream-error", 10000),
          ]);

          // Should have received error event with token limit error
          expect(collector.hasError()).toBe(true);

          // Verify error is properly categorized as context_exceeded
          const errorEvents = collector
            .getEvents()
            .filter((e) => "type" in e && e.type === "stream-error");
          expect(errorEvents.length).toBeGreaterThan(0);

          const errorEvent = errorEvents[0];

          // Verify error type is context_exceeded
          if (errorEvent && "errorType" in errorEvent) {
            expect(errorEvent.errorType).toBe("context_exceeded");
          }

          // NEW: Verify error handling improvements
          // 1. Verify error event includes messageId
          if (errorEvent && "messageId" in errorEvent) {
            expect(errorEvent.messageId).toBeDefined();
            expect(typeof errorEvent.messageId).toBe("string");
          }

          // 2. Verify error persists across "reload" by simulating page reload via IPC
          // Clear sentEvents and trigger subscription (simulates what happens on page reload)
          env.sentEvents.length = 0;

          // Trigger the subscription using ipcRenderer.send() (correct way to trigger ipcMain.on())
          env.mockIpcRenderer.send(`workspace:chat:subscribe`, workspaceId);

          // Wait for the async subscription handler to complete by polling for caught-up
          const reloadCollector = createEventCollector(env.sentEvents, workspaceId);
          const caughtUpMessage = await reloadCollector.waitForEvent("caught-up", 10000);
          expect(caughtUpMessage).toBeDefined();

          // 3. Find the partial message with error metadata in reloaded messages
          const reloadedMessages = reloadCollector.getEvents();
          const partialMessage = reloadedMessages.find(
            (msg) =>
              msg &&
              typeof msg === "object" &&
              "metadata" in msg &&
              msg.metadata &&
              typeof msg.metadata === "object" &&
              "error" in msg.metadata
          );

          // 4. Verify partial message has error metadata
          expect(partialMessage).toBeDefined();
          if (
            partialMessage &&
            typeof partialMessage === "object" &&
            "metadata" in partialMessage &&
            partialMessage.metadata &&
            typeof partialMessage.metadata === "object"
          ) {
            expect("error" in partialMessage.metadata).toBe(true);
            expect("errorType" in partialMessage.metadata).toBe(true);
            expect("partial" in partialMessage.metadata).toBe(true);
            if ("partial" in partialMessage.metadata) {
              expect(partialMessage.metadata.partial).toBe(true);
            }

            // Verify error type is context_exceeded
            if ("errorType" in partialMessage.metadata) {
              expect(partialMessage.metadata.errorType).toBe("context_exceeded");
            }
          }
        });
      },
      30000
    );
  });

  // Tool policy tests
  describe("tool policy", () => {
    // Retry tool policy tests in CI (they depend on external API behavior)
    if (process.env.CI && typeof jest !== "undefined" && jest.retryTimes) {
      jest.retryTimes(2, { logErrorsBeforeRetry: true });
    }

    test.each(PROVIDER_CONFIGS)(
      "%s should respect tool policy that disables bash",
      async (provider, model) => {
        await withSharedWorkspace(provider, async ({ env, workspaceId, workspacePath }) => {
          // Create a test file in the workspace
          const testFilePath = path.join(workspacePath, "bash-test-file.txt");
          await fs.writeFile(testFilePath, "original content", "utf-8");

          // Verify file exists
          expect(
            await fs.access(testFilePath).then(
              () => true,
              () => false
            )
          ).toBe(true);

          // Ask AI to delete the file using bash (which should be disabled)
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Delete the file bash-test-file.txt using bash rm command",
            modelString(provider, model),
            {
              toolPolicy: [{ regex_match: "bash", action: "disable" }],
              ...(provider === "openai"
                ? { providerOptions: { openai: { simulateToolPolicyNoop: true } } }
                : {}),
            }
          );

          // IPC call should succeed
          expect(result.success).toBe(true);

          // Wait for stream to complete (longer timeout for tool policy tests)
          const collector = createEventCollector(env.sentEvents, workspaceId);

          // Wait for either stream-end or stream-error
          // (helpers will log diagnostic info on failure)
          const streamTimeout = provider === "openai" ? 90000 : 30000;
          await Promise.race([
            collector.waitForEvent("stream-end", streamTimeout),
            collector.waitForEvent("stream-error", streamTimeout),
          ]);

          // This will throw with detailed error info if stream didn't complete successfully
          assertStreamSuccess(collector);

          if (provider === "openai") {
            const deltas = collector.getDeltas();
            const noopDelta = deltas.find(
              (event): event is StreamDeltaEvent =>
                "type" in event &&
                event.type === "stream-delta" &&
                typeof (event as StreamDeltaEvent).delta === "string"
            );
            expect(noopDelta?.delta).toContain(
              "Tool execution skipped because the requested tool is disabled by policy."
            );
          }

          // Verify file still exists (bash tool was disabled, so deletion shouldn't have happened)
          const fileStillExists = await fs.access(testFilePath).then(
            () => true,
            () => false
          );
          expect(fileStillExists).toBe(true);

          // Verify content unchanged
          const content = await fs.readFile(testFilePath, "utf-8");
          expect(content).toBe("original content");
        });
      },
      90000
    );

    test.each(PROVIDER_CONFIGS)(
      "%s should respect tool policy that disables file_edit tools",
      async (provider, model) => {
        await withSharedWorkspace(provider, async ({ env, workspaceId, workspacePath }) => {
          // Create a test file with known content
          const testFilePath = path.join(workspacePath, "edit-test-file.txt");
          const originalContent = "original content line 1\noriginal content line 2";
          await fs.writeFile(testFilePath, originalContent, "utf-8");

          // Ask AI to edit the file (which should be disabled)
          // Disable both file_edit tools AND bash to prevent workarounds
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Edit the file edit-test-file.txt and replace 'original' with 'modified'",
            modelString(provider, model),
            {
              toolPolicy: [
                { regex_match: "file_edit_.*", action: "disable" },
                { regex_match: "bash", action: "disable" },
              ],
              ...(provider === "openai"
                ? { providerOptions: { openai: { simulateToolPolicyNoop: true } } }
                : {}),
            }
          );

          // IPC call should succeed
          expect(result.success).toBe(true);

          // Wait for stream to complete (longer timeout for tool policy tests)
          const collector = createEventCollector(env.sentEvents, workspaceId);

          // Wait for either stream-end or stream-error
          // (helpers will log diagnostic info on failure)
          const streamTimeout = provider === "openai" ? 90000 : 30000;
          await Promise.race([
            collector.waitForEvent("stream-end", streamTimeout),
            collector.waitForEvent("stream-error", streamTimeout),
          ]);

          // This will throw with detailed error info if stream didn't complete successfully
          assertStreamSuccess(collector);

          if (provider === "openai") {
            const deltas = collector.getDeltas();
            const noopDelta = deltas.find(
              (event): event is StreamDeltaEvent =>
                "type" in event &&
                event.type === "stream-delta" &&
                typeof (event as StreamDeltaEvent).delta === "string"
            );
            expect(noopDelta?.delta).toContain(
              "Tool execution skipped because the requested tool is disabled by policy."
            );
          }

          // Verify file content unchanged (file_edit tools and bash were disabled)
          const content = await fs.readFile(testFilePath, "utf-8");
          expect(content).toBe(originalContent);
        });
      },
      90000
    );
  });

  // Additional system instructions tests
  describe("additional system instructions", () => {});

  // Test frontend metadata round-trip (no provider needed - just verifies storage)
});
