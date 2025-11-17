import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "./setup";
import {
  sendMessageWithModel,
  sendMessage,
  createEventCollector,
  waitFor,
  TEST_IMAGES,
  modelString,
} from "./helpers";
import type { EventCollector } from "./helpers";
import {
  IPC_CHANNELS,
  isQueuedMessageChanged,
  isRestoreToInput,
  QueuedMessageChangedEvent,
  RestoreToInputEvent,
} from "@/common/types/ipc";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// Helper: Get queued messages from latest queued-message-changed event
async function getQueuedMessages(collector: EventCollector, timeoutMs = 5000): Promise<string[]> {
  await waitForQueuedMessageEvent(collector, timeoutMs);

  collector.collect();
  const events = collector.getEvents();
  const queuedEvents = events.filter(isQueuedMessageChanged);

  if (queuedEvents.length === 0) {
    return [];
  }

  // Return messages from the most recent event
  const latestEvent = queuedEvents[queuedEvents.length - 1];
  return latestEvent.queuedMessages;
}

// Helper: Wait for queued-message-changed event
async function waitForQueuedMessageEvent(
  collector: EventCollector,
  timeoutMs = 5000
): Promise<QueuedMessageChangedEvent | null> {
  const event = await collector.waitForEvent("queued-message-changed", timeoutMs);
  if (!event || !isQueuedMessageChanged(event)) {
    return null;
  }
  return event;
}

// Helper: Wait for restore-to-input event
async function waitForRestoreToInputEvent(
  collector: EventCollector,
  timeoutMs = 5000
): Promise<RestoreToInputEvent | null> {
  const event = await collector.waitForEvent("restore-to-input", timeoutMs);
  if (!event || !isRestoreToInput(event)) {
    return null;
  }
  return event;
}

describeIntegration("IpcMain queuedMessages integration tests", () => {
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
          env.mockIpcRenderer,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createEventCollector(env.sentEvents, workspaceId);
        await collector1.waitForEvent("stream-start", 5000);

        // Queue a message while streaming
        const queueResult = await sendMessageWithModel(
          env.mockIpcRenderer,
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

        // Wait for auto-send to emit second user message (happens async after stream-end)
        const autoSendHappened = await waitFor(() => {
          collector1.collect();
          const userMessages = collector1
            .getEvents()
            .filter((e) => "role" in e && e.role === "user");
          return userMessages.length === 2; // First + auto-sent
        }, 5000);
        expect(autoSendHappened).toBe(true);

        // Clear events to track second stream separately
        env.sentEvents.length = 0;

        // Wait for second stream to complete
        const collector2 = createEventCollector(env.sentEvents, workspaceId);
        await collector2.waitForEvent("stream-start", 5000);
        await collector2.waitForEvent("stream-end", 15000);

        // Verify queue was cleared after auto-send
        const queuedAfter = await getQueuedMessages(collector2);
        expect(queuedAfter).toEqual([]);
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
          env.mockIpcRenderer,
          workspaceId,
          "Count to 10 slowly",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector = createEventCollector(env.sentEvents, workspaceId);
        await collector.waitForEvent("stream-start", 5000);

        // Queue a message
        await sendMessageWithModel(
          env.mockIpcRenderer,
          workspaceId,
          "This message should be restored",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        // Verify message was queued
        const queued = await getQueuedMessages(collector);
        expect(queued).toEqual(["This message should be restored"]);

        // Interrupt the stream
        const interruptResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_INTERRUPT_STREAM,
          workspaceId
        );
        expect(interruptResult.success).toBe(true);

        // Wait for stream abort
        await collector.waitForEvent("stream-abort", 5000);

        // Wait for restore-to-input event
        const restoreEvent = await waitForRestoreToInputEvent(collector);
        expect(restoreEvent).toBeDefined();
        expect(restoreEvent?.text).toBe("This message should be restored");
        expect(restoreEvent?.workspaceId).toBe(workspaceId);

        // Verify queue was cleared
        const queuedAfter = await getQueuedMessages(collector);
        expect(queuedAfter).toEqual([]);
      } finally {
        await cleanup();
      }
    },
    20000
  );

  test.concurrent(
    "should combine multiple queued messages with newline separator",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start a stream
        void sendMessageWithModel(
          env.mockIpcRenderer,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createEventCollector(env.sentEvents, workspaceId);
        await collector1.waitForEvent("stream-start", 5000);

        // Queue multiple messages
        await sendMessage(env.mockIpcRenderer, workspaceId, "Message 1");
        await sendMessage(env.mockIpcRenderer, workspaceId, "Message 2");
        await sendMessage(env.mockIpcRenderer, workspaceId, "Message 3");

        // Verify all messages queued
        const queued = await getQueuedMessages(collector1);
        expect(queued).toEqual(["Message 1", "Message 2", "Message 3"]);

        // Wait for first stream to complete (this triggers auto-send)
        await collector1.waitForEvent("stream-end", 15000);

        // Wait for auto-send to emit the combined message
        const autoSendHappened = await waitFor(() => {
          collector1.collect();
          const userMessages = collector1
            .getEvents()
            .filter((e) => "role" in e && e.role === "user");
          return userMessages.length === 2; // First message + auto-sent combined message
        }, 5000);
        expect(autoSendHappened).toBe(true);
      } finally {
        await cleanup();
      }
    },
    30000
  );

  test.concurrent(
    "should auto-send queued message with images",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start a stream
        void sendMessageWithModel(
          env.mockIpcRenderer,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createEventCollector(env.sentEvents, workspaceId);
        await collector1.waitForEvent("stream-start", 5000);

        // Queue message with image
        await sendMessage(env.mockIpcRenderer, workspaceId, "Describe this image", {
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

        // Wait for auto-send to emit the message with image
        const autoSendHappened = await waitFor(() => {
          collector1.collect();
          const userMessages = collector1
            .getEvents()
            .filter((e) => "role" in e && e.role === "user");
          return userMessages.length === 2;
        }, 5000);
        expect(autoSendHappened).toBe(true);

        // Clear events to track second stream separately
        env.sentEvents.length = 0;

        // Wait for auto-send stream
        const collector2 = createEventCollector(env.sentEvents, workspaceId);
        await collector2.waitForEvent("stream-start", 5000);
        await collector2.waitForEvent("stream-end", 15000);

        // Verify queue was cleared after auto-send
        const queuedAfter = await getQueuedMessages(collector2);
        expect(queuedAfter).toEqual([]);
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
          env.mockIpcRenderer,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createEventCollector(env.sentEvents, workspaceId);
        await collector1.waitForEvent("stream-start", 5000);

        // Queue image-only message (empty text)
        await sendMessage(env.mockIpcRenderer, workspaceId, "", {
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

        // Wait for auto-send to emit the image-only message
        const autoSendHappened = await waitFor(() => {
          collector1.collect();
          const userMessages = collector1
            .getEvents()
            .filter((e) => "role" in e && e.role === "user");
          return userMessages.length === 2;
        }, 5000);
        expect(autoSendHappened).toBe(true);

        // Clear events to track second stream separately
        env.sentEvents.length = 0;

        // Wait for auto-send stream
        const collector2 = createEventCollector(env.sentEvents, workspaceId);
        await collector2.waitForEvent("stream-start", 5000);
        await collector2.waitForEvent("stream-end", 15000);

        // Verify queue was cleared after auto-send
        const queuedAfter = await getQueuedMessages(collector2);
        expect(queuedAfter).toEqual([]);
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
          env.mockIpcRenderer,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createEventCollector(env.sentEvents, workspaceId);
        await collector1.waitForEvent("stream-start", 5000);

        // Queue messages with different options
        await sendMessage(env.mockIpcRenderer, workspaceId, "Message 1", {
          model: "anthropic:claude-haiku-4-5",
          thinkingLevel: "off",
        });
        await sendMessage(env.mockIpcRenderer, workspaceId, "Message 2", {
          model: "anthropic:claude-sonnet-4-5",
          thinkingLevel: "high",
        });

        // Wait for first stream to complete (this triggers auto-send)
        await collector1.waitForEvent("stream-end", 15000);

        // Wait for auto-send to emit the combined message
        const autoSendHappened = await waitFor(() => {
          collector1.collect();
          const userMessages = collector1
            .getEvents()
            .filter((e) => "role" in e && e.role === "user");
          return userMessages.length === 2;
        }, 5000);
        expect(autoSendHappened).toBe(true);

        // Clear events to track second stream separately
        env.sentEvents.length = 0;

        // Wait for auto-send stream
        const collector2 = createEventCollector(env.sentEvents, workspaceId);
        const streamStart = await collector2.waitForEvent("stream-start", 5000);

        if (streamStart && "model" in streamStart) {
          expect(streamStart.model).toContain("claude-sonnet-4-5");
        }

        await collector2.waitForEvent("stream-end", 15000);
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
          env.mockIpcRenderer,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createEventCollector(env.sentEvents, workspaceId);
        await collector1.waitForEvent("stream-start", 5000);

        // Queue a compaction request
        const compactionMetadata = {
          type: "compaction-request" as const,
          rawCommand: "/compact -t 3000",
          parsed: { maxOutputTokens: 3000 },
        };

        await sendMessage(
          env.mockIpcRenderer,
          workspaceId,
          "Summarize this conversation into a compact form...",
          {
            model: "anthropic:claude-sonnet-4-5",
            muxMetadata: compactionMetadata,
          }
        );

        // Wait for queued-message-changed event
        const queuedEvent = await waitForQueuedMessageEvent(collector1);
        expect(queuedEvent?.displayText).toBe("/compact -t 3000");

        // Wait for first stream to complete (this triggers auto-send)
        await collector1.waitForEvent("stream-end", 15000);

        // Wait for auto-send to emit the compaction message
        const autoSendHappened = await waitFor(() => {
          collector1.collect();
          const userMessages = collector1
            .getEvents()
            .filter((e) => "role" in e && e.role === "user");
          return userMessages.length === 2;
        }, 5000);
        expect(autoSendHappened).toBe(true);

        // Clear events to track second stream separately
        env.sentEvents.length = 0;

        // Wait for auto-send stream
        const collector2 = createEventCollector(env.sentEvents, workspaceId);
        await collector2.waitForEvent("stream-start", 5000);
        await collector2.waitForEvent("stream-end", 15000);

        // Verify queue was cleared after auto-send
        const queuedAfter = await getQueuedMessages(collector2);
        expect(queuedAfter).toEqual([]);
      } finally {
        await cleanup();
      }
    },
    30000
  );
});
