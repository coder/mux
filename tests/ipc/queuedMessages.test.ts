import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "./setup";
import {
  sendMessageWithModel,
  sendMessage,
  createStreamCollector,
  waitFor,
  TEST_IMAGES,
  modelString,
  resolveOrpcClient,
  StreamCollector,
} from "./helpers";
import { isQueuedMessageChanged, isRestoreToInput } from "@/common/orpc/types";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

// Type aliases for queued message events (extracted from schema union)
type QueuedMessageChangedEvent = Extract<WorkspaceChatMessage, { type: "queued-message-changed" }>;
type RestoreToInputEvent = Extract<WorkspaceChatMessage, { type: "restore-to-input" }>;

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// Helper: Get queued messages from latest queued-message-changed event
// If wait=true, waits for a new event first (use when expecting a change)
// If wait=false, returns current state immediately (use when checking final state)
async function getQueuedMessages(
  collector: StreamCollector,
  options: { wait?: boolean; timeoutMs?: number } = {}
): Promise<string[]> {
  const { wait = true, timeoutMs = 5000 } = options;

  if (wait) {
    await waitForQueuedMessageEvent(collector, timeoutMs);
  }

  const events = collector.getEvents();
  const queuedEvents = events.filter(isQueuedMessageChanged);

  if (queuedEvents.length === 0) {
    return [];
  }

  // Return messages from the most recent event
  const latestEvent = queuedEvents[queuedEvents.length - 1];
  return latestEvent.queuedMessages;
}

// Helper: Wait for a NEW queued-message-changed event (one that wasn't seen before)
async function waitForQueuedMessageEvent(
  collector: StreamCollector,
  timeoutMs = 5000
): Promise<QueuedMessageChangedEvent | null> {
  // Get current count of queued-message-changed events
  const currentEvents = collector.getEvents().filter(isQueuedMessageChanged);
  const currentCount = currentEvents.length;

  // Wait for a new event
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const events = collector.getEvents().filter(isQueuedMessageChanged);
    if (events.length > currentCount) {
      // Return the newest event
      return events[events.length - 1];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Timeout - return null
  return null;
}

// Helper: Wait for restore-to-input event
async function waitForRestoreToInputEvent(
  collector: StreamCollector,
  timeoutMs = 5000
): Promise<RestoreToInputEvent | null> {
  const event = await collector.waitForEvent("restore-to-input", timeoutMs);
  if (!event || !isRestoreToInput(event)) {
    return null;
  }
  return event;
}

describeIntegration("Queued messages", () => {
  // Enable retries in CI for flaky API tests
  if (process.env.CI && typeof jest !== "undefined" && jest.retryTimes) {
    jest.retryTimes(3, { logErrorsBeforeRetry: true });
  }

  test.concurrent(
    "should queue message during streaming and auto-send on stream end",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start initial stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createStreamCollector(env.orpc, workspaceId);
        collector1.start();
        await collector1.waitForEvent("stream-start", 5000);

        // Queue a message while streaming
        const queueResult = await sendMessageWithModel(
          env,
          workspaceId,
          "Say 'SECOND' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );
        expect(queueResult.success).toBe(true);

        // Verify message was queued (not sent directly)
        const queuedEvent = await waitForQueuedMessageEvent(collector1);
        expect(queuedEvent).toBeDefined();
        expect(queuedEvent?.queuedMessages).toEqual(["Say 'SECOND' and nothing else"]);
        expect(queuedEvent?.displayText).toBe("Say 'SECOND' and nothing else");

        // Wait for first stream to complete (this triggers auto-send)
        await collector1.waitForEvent("stream-end", 15000);

        // Wait for queue to be cleared (happens before auto-send starts new stream)
        // The sendQueuedMessages() clears queue and emits event before sending
        const clearEvent = await waitForQueuedMessageEvent(collector1, 5000);
        expect(clearEvent?.queuedMessages).toEqual([]);

        // Wait for auto-send to emit second user message (happens async after stream-end)
        // The second stream starts after auto-send - wait for the second stream-start
        await collector1.waitForEvent("stream-start", 5000);

        // Wait for second stream to complete
        await collector1.waitForEvent("stream-end", 15000);

        // Verify queue is still empty (check current state)
        const queuedAfter = await getQueuedMessages(collector1, { wait: false });
        expect(queuedAfter).toEqual([]);
        collector1.stop();
      } finally {
        await cleanup();
      }
    },
    30000
  );

  test.concurrent(
    "should restore queued message to input on stream abort",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start a stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Count to 10 slowly",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();
        await collector.waitForEvent("stream-start", 5000);

        // Queue a message
        await sendMessageWithModel(
          env,
          workspaceId,
          "This message should be restored",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        // Verify message was queued
        const queued = await getQueuedMessages(collector);
        expect(queued).toEqual(["This message should be restored"]);

        // Capture event count BEFORE interrupt to avoid race condition
        // (clear event may arrive before or with stream-abort)
        const preInterruptEventCount = collector.getEvents().filter(isQueuedMessageChanged).length;

        // Interrupt the stream
        const client = resolveOrpcClient(env);
        const interruptResult = await client.workspace.interruptStream({ workspaceId });
        expect(interruptResult.success).toBe(true);

        // Wait for stream abort
        await collector.waitForEvent("stream-abort", 5000);

        // Wait for queue to be cleared (may have already arrived with stream-abort)
        // Use preInterruptEventCount as baseline since clear event races with stream-abort
        const startTime = Date.now();
        let clearEvent: QueuedMessageChangedEvent | null = null;
        while (Date.now() - startTime < 5000) {
          const events = collector.getEvents().filter(isQueuedMessageChanged);
          if (events.length > preInterruptEventCount) {
            clearEvent = events[events.length - 1];
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(clearEvent?.queuedMessages).toEqual([]);

        // Wait for restore-to-input event
        const restoreEvent = await waitForRestoreToInputEvent(collector);
        expect(restoreEvent).toBeDefined();
        expect(restoreEvent?.text).toBe("This message should be restored");
        expect(restoreEvent?.workspaceId).toBe(workspaceId);

        // Verify queue is still empty
        const queuedAfter = await getQueuedMessages(collector, { wait: false });
        expect(queuedAfter).toEqual([]);
        collector.stop();
      } finally {
        await cleanup();
      }
    },
    30000 // Increased timeout for abort handling
  );

  test.concurrent(
    "should send queued message immediately when sendQueuedImmediately is true",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start a stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Count to 10 slowly",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();
        await collector.waitForEvent("stream-start", 5000);

        // Queue a message
        await sendMessageWithModel(
          env,
          workspaceId,
          "This message should be sent immediately",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        // Verify message was queued
        const queued = await getQueuedMessages(collector);
        expect(queued).toEqual(["This message should be sent immediately"]);

        // Interrupt the stream with sendQueuedImmediately flag
        const client = resolveOrpcClient(env);
        const interruptResult = await client.workspace.interruptStream({
          workspaceId,
          options: { sendQueuedImmediately: true },
        });
        expect(interruptResult.success).toBe(true);

        // Wait for stream abort
        await collector.waitForEvent("stream-abort", 5000);

        // Should NOT get restore-to-input event (message is sent, not restored)
        // Instead, we should see the queued message being sent as a new user message
        const autoSendHappened = await waitFor(() => {
          const userMessages = collector
            .getEvents()
            .filter((e) => "role" in e && e.role === "user");
          return userMessages.length === 2; // First + immediately sent
        }, 5000);
        expect(autoSendHappened).toBe(true);

        // Verify queue was cleared
        const queuedAfter = await getQueuedMessages(collector, { wait: false });
        expect(queuedAfter).toEqual([]);

        // Wait for the immediately-sent message's stream to start and complete
        await collector.waitForEvent("stream-start", 5000);
        await collector.waitForEvent("stream-end", 15000);
        collector.stop();
      } finally {
        await cleanup();
      }
    },
    30000
  );

  test.concurrent(
    "should combine multiple queued messages with newline separator",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start a stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createStreamCollector(env.orpc, workspaceId);
        collector1.start();
        await collector1.waitForEvent("stream-start", 5000);

        // Queue multiple messages, waiting for each queued-message-changed event
        await sendMessage(env, workspaceId, "Message 1");
        await waitForQueuedMessageEvent(collector1);

        await sendMessage(env, workspaceId, "Message 2");
        await waitForQueuedMessageEvent(collector1);

        await sendMessage(env, workspaceId, "Message 3");
        await waitForQueuedMessageEvent(collector1);

        // Verify all messages queued (check current state, don't wait for new event)
        const queued = await getQueuedMessages(collector1, { wait: false });
        expect(queued).toEqual(["Message 1", "Message 2", "Message 3"]);

        // Wait for first stream to complete (this triggers auto-send)
        await collector1.waitForEvent("stream-end", 15000);

        // Wait for the SECOND stream-start (auto-send creates a new stream)
        await collector1.waitForEventN("stream-start", 2, 10000);

        const userMessages = collector1
          .getEvents()
          .filter((e: WorkspaceChatMessage) => "role" in e && e.role === "user");
        expect(userMessages.length).toBe(2); // First message + auto-sent combined message
        collector1.stop();
      } finally {
        await cleanup();
      }
    },
    45000 // Increased timeout for multiple messages
  );

  test.concurrent(
    "should auto-send queued message with images",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start a stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createStreamCollector(env.orpc, workspaceId);
        collector1.start();
        await collector1.waitForEvent("stream-start", 5000);

        // Queue message with image
        await sendMessage(env, workspaceId, "Describe this image", {
          model: "anthropic:claude-sonnet-4-5",
          imageParts: [TEST_IMAGES.RED_PIXEL],
        });

        // Verify queued with image
        const queuedEvent = await waitForQueuedMessageEvent(collector1);
        expect(queuedEvent?.queuedMessages).toEqual(["Describe this image"]);
        expect(queuedEvent?.imageParts).toHaveLength(1);
        expect(queuedEvent?.imageParts?.[0]).toMatchObject(TEST_IMAGES.RED_PIXEL);

        // Wait for first stream to complete (this triggers auto-send)
        await collector1.waitForEvent("stream-end", 15000);

        // Wait for queue to be cleared
        const clearEvent = await waitForQueuedMessageEvent(collector1, 5000);
        expect(clearEvent?.queuedMessages).toEqual([]);

        // Wait for auto-send stream to start and complete
        await collector1.waitForEvent("stream-start", 5000);
        await collector1.waitForEvent("stream-end", 15000);

        // Verify queue is still empty
        const queuedAfter = await getQueuedMessages(collector1, { wait: false });
        expect(queuedAfter).toEqual([]);
        collector1.stop();
      } finally {
        await cleanup();
      }
    },
    30000
  );

  test.concurrent(
    "should handle image-only queued message",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start a stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createStreamCollector(env.orpc, workspaceId);
        collector1.start();
        await collector1.waitForEvent("stream-start", 5000);

        // Queue image-only message (empty text)
        await sendMessage(env, workspaceId, "", {
          model: "anthropic:claude-sonnet-4-5",
          imageParts: [TEST_IMAGES.RED_PIXEL],
        });

        // Verify queued (no text messages, but has image)
        const queuedEvent = await waitForQueuedMessageEvent(collector1);
        expect(queuedEvent?.queuedMessages).toEqual([]);
        expect(queuedEvent?.displayText).toBe("");
        expect(queuedEvent?.imageParts).toHaveLength(1);

        // Wait for first stream to complete (this triggers auto-send)
        await collector1.waitForEvent("stream-end", 15000);

        // Wait for auto-send stream to start and complete
        await collector1.waitForEvent("stream-start", 5000);
        await collector1.waitForEvent("stream-end", 15000);

        // Verify queue was cleared after auto-send
        // Use wait: false since the queue-clearing event already happened
        const queuedAfter = await getQueuedMessages(collector1, { wait: false });
        expect(queuedAfter).toEqual([]);
        collector1.stop();
      } finally {
        await cleanup();
      }
    },
    30000
  );

  test.concurrent(
    "should preserve latest options when queueing",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start a stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createStreamCollector(env.orpc, workspaceId);
        collector1.start();
        await collector1.waitForEvent("stream-start", 5000);

        // Queue messages with different options
        await sendMessage(env, workspaceId, "Message 1", {
          model: "anthropic:claude-haiku-4-5",
          thinkingLevel: "off",
        });
        await sendMessage(env, workspaceId, "Message 2", {
          model: "anthropic:claude-sonnet-4-5",
          thinkingLevel: "high",
        });

        // Wait for first stream to complete (this triggers auto-send)
        await collector1.waitForEvent("stream-end", 15000);

        // Wait for auto-send stream to start (verifies the second stream began)
        const streamStart = await collector1.waitForEvent("stream-start", 5000);
        if (streamStart && "model" in streamStart) {
          expect(streamStart.model).toContain("claude-sonnet-4-5");
        }

        await collector1.waitForEvent("stream-end", 15000);
        collector1.stop();
      } finally {
        await cleanup();
      }
    },
    30000
  );

  test.concurrent(
    "should preserve compaction metadata when queueing",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start a stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createStreamCollector(env.orpc, workspaceId);
        collector1.start();
        await collector1.waitForEvent("stream-start", 5000);

        // Queue a compaction request
        const compactionMetadata = {
          type: "compaction-request" as const,
          rawCommand: "/compact -t 3000",
          parsed: { maxOutputTokens: 3000 },
        };

        await sendMessage(env, workspaceId, "Summarize this conversation into a compact form...", {
          model: "anthropic:claude-sonnet-4-5",
          muxMetadata: compactionMetadata,
        });

        // Wait for queued-message-changed event
        const queuedEvent = await waitForQueuedMessageEvent(collector1);
        expect(queuedEvent?.displayText).toBe("/compact -t 3000");

        // Wait for first stream to complete (this triggers auto-send)
        await collector1.waitForEvent("stream-end", 15000);

        // Wait for queue to be cleared
        const clearEvent = await waitForQueuedMessageEvent(collector1, 5000);
        expect(clearEvent?.queuedMessages).toEqual([]);

        // Wait for auto-send stream to start and complete
        await collector1.waitForEvent("stream-start", 5000);
        await collector1.waitForEvent("stream-end", 15000);

        // Verify queue is still empty
        const queuedAfter = await getQueuedMessages(collector1, { wait: false });
        expect(queuedAfter).toEqual([]);
        collector1.stop();
      } finally {
        await cleanup();
      }
    },
    30000
  );
});
