import * as fs from "fs/promises";
import * as path from "path";
import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "./setup";
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
  TEST_IMAGES,
  modelString,
  configureTestRetries,
} from "./helpers";
import {
  createSharedRepo,
  cleanupSharedRepo,
  withSharedWorkspace,
  withSharedWorkspaceNoProvider,
} from "./sendMessageTestHelpers";
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
      "should successfully send message and receive response",
      async () => {
        await withSharedWorkspace(provider, async ({ env, workspaceId }) => {
          // Send a simple message
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Say 'hello' and nothing else",
            modelString(provider, model)
          );

          // Verify the IPC call succeeded
          expect(result.success).toBe(true);

          // Collect and verify stream events
          const collector = createEventCollector(env.sentEvents, workspaceId);
          const streamEnd = await collector.waitForEvent("stream-end");

          expect(streamEnd).toBeDefined();
          assertStreamSuccess(collector);

          // Verify we received deltas
          const deltas = collector.getDeltas();
          expect(deltas.length).toBeGreaterThan(0);
        });
      },
      15000
    );

    test.concurrent(
      "should interrupt streaming with interruptStream()",
      async () => {
        await withSharedWorkspace(provider, async ({ env, workspaceId }) => {
          // Start a long-running stream with a bash command that takes time
          const longMessage = "Run this bash command: while true; do sleep 1; done";
          void sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            longMessage,
            modelString(provider, model)
          );

          // Wait for stream to start
          const collector = createEventCollector(env.sentEvents, workspaceId);
          await collector.waitForEvent("stream-start", 5000);

          // Use interruptStream() to interrupt
          const interruptResult = await env.mockIpcRenderer.invoke(
            IPC_CHANNELS.WORKSPACE_INTERRUPT_STREAM,
            workspaceId
          );

          // Should succeed (interrupt is not an error)
          expect(interruptResult.success).toBe(true);

          // Wait for abort or end event
          const abortOrEndReceived = await waitFor(() => {
            collector.collect();
            const hasAbort = collector
              .getEvents()
              .some((e) => "type" in e && e.type === "stream-abort");
            const hasEnd = collector.hasStreamEnd();
            return hasAbort || hasEnd;
          }, 5000);

          expect(abortOrEndReceived).toBe(true);
        });
      },
      15000
    );

    test.concurrent(
      "should interrupt stream with pending bash tool call near-instantly",
      async () => {
        await withSharedWorkspace(provider, async ({ env, workspaceId }) => {
          // Ask the model to run a long-running bash command
          // Use explicit instruction to ensure tool call happens
          const message = "Use the bash tool to run: sleep 60";
          void sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            message,
            modelString(provider, model)
          );

          // Wait for stream to start (more reliable than waiting for tool-call-start)
          const collector = createEventCollector(env.sentEvents, workspaceId);
          await collector.waitForEvent("stream-start", 10000);

          // Give model time to start calling the tool (sleep command should be in progress)
          // This ensures we're actually interrupting a running command
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Record interrupt time
          const interruptStartTime = performance.now();

          // Interrupt the stream
          const interruptResult = await env.mockIpcRenderer.invoke(
            IPC_CHANNELS.WORKSPACE_INTERRUPT_STREAM,
            workspaceId
          );

          const interruptDuration = performance.now() - interruptStartTime;

          // Should succeed
          expect(interruptResult.success).toBe(true);

          // Interrupt should complete near-instantly (< 2 seconds)
          // This validates that we don't wait for the sleep 60 command to finish
          expect(interruptDuration).toBeLessThan(2000);

          // Wait for abort event
          const abortOrEndReceived = await waitFor(() => {
            collector.collect();
            const hasAbort = collector
              .getEvents()
              .some((e) => "type" in e && e.type === "stream-abort");
            const hasEnd = collector.hasStreamEnd();
            return hasAbort || hasEnd;
          }, 5000);

          expect(abortOrEndReceived).toBe(true);
        });
      },
      25000
    );

    test.concurrent(
      "should include tokens and timestamp in delta events",
      async () => {
        await withSharedWorkspace(provider, async ({ env, workspaceId }) => {
          // Send a message that will generate text deltas
          // Disable reasoning for this test to avoid flakiness and encrypted content issues in CI
          void sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Write a short paragraph about TypeScript",
            modelString(provider, model),
            { thinkingLevel: "off" }
          );

          // Wait for stream to start
          const collector = createEventCollector(env.sentEvents, workspaceId);
          await collector.waitForEvent("stream-start", 5000);

          // Wait for first delta event
          const deltaEvent = await collector.waitForEvent("stream-delta", 5000);
          expect(deltaEvent).toBeDefined();

          // Verify delta event has tokens and timestamp
          if (deltaEvent && "type" in deltaEvent && deltaEvent.type === "stream-delta") {
            expect("tokens" in deltaEvent).toBe(true);
            expect("timestamp" in deltaEvent).toBe(true);
            expect("delta" in deltaEvent).toBe(true);

            // Verify types
            if ("tokens" in deltaEvent) {
              expect(typeof deltaEvent.tokens).toBe("number");
              expect(deltaEvent.tokens).toBeGreaterThanOrEqual(0);
            }
            if ("timestamp" in deltaEvent) {
              expect(typeof deltaEvent.timestamp).toBe("number");
              expect(deltaEvent.timestamp).toBeGreaterThan(0);
            }
          }

          // Collect all events and sum tokens
          await collector.waitForEvent("stream-end", 10000);
          const allEvents = collector.getEvents();
          const deltaEvents = allEvents.filter(
            (e) =>
              "type" in e &&
              (e.type === "stream-delta" ||
                e.type === "reasoning-delta" ||
                e.type === "tool-call-delta")
          );

          // Should have received multiple delta events
          expect(deltaEvents.length).toBeGreaterThan(0);

          // Calculate total tokens from deltas
          let totalTokens = 0;
          for (const event of deltaEvents) {
            if ("tokens" in event && typeof event.tokens === "number") {
              totalTokens += event.tokens;
            }
          }

          // Total should be greater than 0
          expect(totalTokens).toBeGreaterThan(0);

          // Verify stream completed successfully
          assertStreamSuccess(collector);
        });
      },
      30000 // Increased timeout for OpenAI models which can be slower in CI
    );

    test.concurrent(
      "should include usage data in stream-abort events",
      async () => {
        await withSharedWorkspace(provider, async ({ env, workspaceId }) => {
          // Start a stream that will generate some tokens
          const message = "Write a haiku about coding";
          void sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            message,
            modelString(provider, model)
          );

          // Wait for stream to start and get some deltas
          const collector = createEventCollector(env.sentEvents, workspaceId);
          await collector.waitForEvent("stream-start", 5000);

          // Wait a bit for some content to be generated
          await new Promise((resolve) => setTimeout(resolve, 1000));

          // Interrupt the stream with interruptStream()
          const interruptResult = await env.mockIpcRenderer.invoke(
            IPC_CHANNELS.WORKSPACE_INTERRUPT_STREAM,
            workspaceId
          );

          expect(interruptResult.success).toBe(true);

          // Collect all events and find abort event
          await waitFor(() => {
            collector.collect();
            return collector.getEvents().some((e) => "type" in e && e.type === "stream-abort");
          }, 5000);

          const abortEvent = collector
            .getEvents()
            .find((e) => "type" in e && e.type === "stream-abort");
          expect(abortEvent).toBeDefined();

          // Verify abort event structure
          if (abortEvent && "metadata" in abortEvent) {
            // Metadata should exist with duration
            expect(abortEvent.metadata).toBeDefined();
            expect(abortEvent.metadata?.duration).toBeGreaterThan(0);

            // Usage MAY be present depending on abort timing:
            // - Early abort: usage is undefined (stream didn't complete)
            // - Late abort: usage available (stream finished before UI processed it)
            if (abortEvent.metadata?.usage) {
              expect(abortEvent.metadata.usage.inputTokens).toBeGreaterThan(0);
              expect(abortEvent.metadata.usage.outputTokens).toBeGreaterThanOrEqual(0);
            }
          }
        });
      },
      15000
    );

    test.concurrent(
      "should handle reconnection during active stream",
      async () => {
        // Only test with Anthropic (faster and more reliable for this test)
        if (provider === "openai") {
          return;
        }

        await withSharedWorkspace(provider, async ({ env, workspaceId }) => {
          // Start a stream with tool call that takes a long time
          void sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Run this bash command: while true; do sleep 0.1; done",
            modelString(provider, model)
          );

          // Wait for tool-call-start (which means model is executing bash)
          const collector1 = createEventCollector(env.sentEvents, workspaceId);
          const streamStartEvent = await collector1.waitForEvent("stream-start", 5000);
          expect(streamStartEvent).toBeDefined();

          await collector1.waitForEvent("tool-call-start", 10000);

          // At this point, bash loop is running (will run forever if abort doesn't work)
          // Get message ID for verification
          collector1.collect();
          const messageId =
            streamStartEvent && "messageId" in streamStartEvent
              ? streamStartEvent.messageId
              : undefined;
          expect(messageId).toBeDefined();

          // Simulate reconnection by clearing events and re-subscribing
          env.sentEvents.length = 0;

          // Use ipcRenderer.send() to trigger ipcMain.on() handler (correct way for electron-mock-ipc)
          env.mockIpcRenderer.send("workspace:chat:subscribe", workspaceId);

          // Wait for async subscription handler to complete by polling for caught-up
          const collector2 = createEventCollector(env.sentEvents, workspaceId);
          const caughtUpMessage = await collector2.waitForEvent("caught-up", 5000);
          expect(caughtUpMessage).toBeDefined();

          // Collect all reconnection events
          collector2.collect();
          const reconnectionEvents = collector2.getEvents();

          // Verify we received stream-start event (not a partial message with INTERRUPTED)
          const reconnectStreamStart = reconnectionEvents.find(
            (e) => "type" in e && e.type === "stream-start"
          );

          // If stream completed before reconnection, we'll get a regular message instead
          // This is expected behavior - only active streams get replayed
          const hasStreamStart = !!reconnectStreamStart;
          const hasRegularMessage = reconnectionEvents.some(
            (e) => "role" in e && e.role === "assistant"
          );

          // Either we got stream replay (active stream) OR regular message (completed stream)
          expect(hasStreamStart || hasRegularMessage).toBe(true);

          // If we did get stream replay, verify it
          if (hasStreamStart) {
            expect(reconnectStreamStart).toBeDefined();
            expect(
              reconnectStreamStart && "messageId" in reconnectStreamStart
                ? reconnectStreamStart.messageId
                : undefined
            ).toBe(messageId);

            // Verify we received tool-call-start (replay of accumulated tool event)
            const reconnectToolStart = reconnectionEvents.filter(
              (e) => "type" in e && e.type === "tool-call-start"
            );
            expect(reconnectToolStart.length).toBeGreaterThan(0);

            // Verify we did NOT receive a partial message (which would show INTERRUPTED)
            const partialMessages = reconnectionEvents.filter(
              (e) =>
                "role" in e &&
                e.role === "assistant" &&
                "metadata" in e &&
                (e as { metadata?: { partial?: boolean } }).metadata?.partial === true
            );
            expect(partialMessages.length).toBe(0);
          }

          // Note: If test completes quickly (~5s), abort signal worked and killed the loop
          // If test takes much longer, abort signal didn't work
        });
      },
      15000
    );
  });

  // Test frontend metadata round-trip (no provider needed - just verifies storage)
  test.concurrent(
    "should preserve arbitrary frontend metadata through IPC round-trip",
    async () => {
      await withSharedWorkspaceNoProvider(async ({ env, workspaceId }) => {
        // Create structured metadata
        const testMetadata = {
          type: "compaction-request" as const,
          rawCommand: "/compact -c continue working",
          parsed: {
            maxOutputTokens: 5000,
            continueMessage: "continue working",
          },
        };

        // Send a message with frontend metadata
        // Use invalid model to fail fast - we only care about metadata storage
        const result = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_SEND_MESSAGE,
          workspaceId,
          "Test message with metadata",
          {
            model: "openai:gpt-4", // Valid format but provider not configured - will fail after storing message
            muxMetadata: testMetadata,
          }
        );

        // Note: IPC call will fail due to missing provider config, but that's okay
        // We only care that the user message was written to history with metadata
        // (sendMessage writes user message before attempting to stream)

        // Use event collector to get messages sent to frontend
        const collector = createEventCollector(env.sentEvents, workspaceId);

        // Wait for the user message to appear in the chat channel
        await waitFor(() => {
          const messages = collector.collect();
          return messages.some((m) => "role" in m && m.role === "user");
        }, 2000);

        // Get all messages for this workspace
        const allMessages = collector.collect();

        // Find the user message we just sent
        const userMessage = allMessages.find((msg) => "role" in msg && msg.role === "user");
        expect(userMessage).toBeDefined();

        // Verify metadata was preserved exactly as sent (black-box)
        expect(userMessage).toHaveProperty("metadata");
        const metadata = (userMessage as any).metadata;
        expect(metadata).toHaveProperty("muxMetadata");
        expect(metadata.muxMetadata).toEqual(testMetadata);

        // Verify structured fields are accessible
        expect(metadata.muxMetadata.type).toBe("compaction-request");
        expect(metadata.muxMetadata.rawCommand).toBe("/compact -c continue working");
        expect(metadata.muxMetadata.parsed.continueMessage).toBe("continue working");
        expect(metadata.muxMetadata.parsed.maxOutputTokens).toBe(5000);
      });
    },
    5000
  );
});

// Test image support across providers
describe.each(PROVIDER_CONFIGS)("%s:%s image support", (provider, model) => {});
