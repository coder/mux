import { describe, it, expect, beforeEach, mock } from "bun:test";
import { CompactionHandler, type ActiveCompactionOperation } from "./compactionHandler";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";
import type { EventEmitter } from "events";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { StreamEndEvent } from "@/common/types/stream";
import type { TelemetryService } from "./telemetryService";
import type { TelemetryEventPayload } from "@/common/telemetry/payload";
import { Ok, Err, type Result } from "@/common/types/result";

interface EmittedEvent {
  event: string;
  data: ChatEventData;
}

// Type guards for emitted events
interface ChatEventData {
  workspaceId: string;
  message: unknown;
}

const createMockHistoryService = () => {
  let getHistoryResult: Result<MuxMessage[], string> = Ok([]);
  let replaceHistoryResult: Result<number[], string> = Ok([]);

  const getHistory = mock((_) => Promise.resolve(getHistoryResult));
  const replaceHistory = mock((_, __) => Promise.resolve(replaceHistoryResult));

  // Unused in compaction tests, but kept for interface compatibility
  const updateHistory = mock(() => Promise.resolve(Ok(undefined)));
  const truncateAfterMessage = mock(() => Promise.resolve(Ok(undefined)));

  return {
    getHistory,
    replaceHistory,
    updateHistory,
    truncateAfterMessage,
    // Allow setting mock return values
    mockGetHistory: (result: Result<MuxMessage[], string>) => {
      getHistoryResult = result;
    },
    mockReplaceHistory: (result: Result<number[], string>) => {
      replaceHistoryResult = result;
    },
  };
};

const createMockPartialService = () => {
  let deletePartialResult: Result<void, string> = Ok(undefined);

  const deletePartial = mock((_) => Promise.resolve(deletePartialResult));
  const readPartial = mock((_) => Promise.resolve(null));
  const writePartial = mock((_, __) => Promise.resolve(Ok(undefined)));
  const commitToHistory = mock((_) => Promise.resolve(Ok(undefined)));

  return {
    deletePartial,
    readPartial,
    writePartial,
    commitToHistory,
    // Allow setting mock return values
    mockDeletePartial: (result: Result<void, string>) => {
      deletePartialResult = result;
    },
  };
};

const createMockEmitter = (): { emitter: EventEmitter; events: EmittedEvent[] } => {
  const events: EmittedEvent[] = [];
  const emitter = {
    emit: (_event: string, data: ChatEventData) => {
      events.push({ event: _event, data });
      return true;
    },
  };
  return { emitter: emitter as EventEmitter, events };
};

/** Helper: create a normal user message (not compaction) */
const createNormalUserMessage = (id = "msg-1"): MuxMessage =>
  createMuxMessage(id, "user", "Hello, how are you?", {
    historySequence: 0,
    muxMetadata: { type: "normal" },
  });

/** Helper: create a valid long summary (>=50 words) */
const createValidSummary = (): string =>
  "This is a comprehensive summary of the conversation. The user wanted to build a feature for their application. " +
  "We discussed the requirements and architecture. Key decisions included using TypeScript for type safety, " +
  "implementing a control-plane pattern for reliability, and adding validation for data integrity. " +
  "The implementation is now complete with proper error handling and tests. " +
  "Next steps involve deployment and monitoring of the new feature in production.";

const createStreamEndEvent = (
  summary: string,
  metadata?: Record<string, unknown>
): StreamEndEvent => ({
  type: "stream-end",
  workspaceId: "test-workspace",
  messageId: "msg-id",
  parts: [{ type: "text", text: summary }],
  metadata: {
    model: "claude-3-5-sonnet-20241022",
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: undefined },
    duration: 1500,
    ...metadata,
  },
});

// DRY helper to set up successful compaction scenario
const setupSuccessfulCompaction = (
  mockHistoryService: ReturnType<typeof createMockHistoryService>,
  messages: MuxMessage[] = [createNormalUserMessage()],
  deletedSequences?: number[]
) => {
  mockHistoryService.mockGetHistory(Ok(messages));
  mockHistoryService.mockReplaceHistory(Ok(deletedSequences ?? messages.map((_, i) => i)));
};

describe("CompactionHandler", () => {
  let handler: CompactionHandler;
  let mockHistoryService: ReturnType<typeof createMockHistoryService>;
  let mockPartialService: ReturnType<typeof createMockPartialService>;
  let mockEmitter: EventEmitter;
  let telemetryCapture: ReturnType<typeof mock>;
  let telemetryService: TelemetryService;
  let emittedEvents: EmittedEvent[];
  let activeOperation: ActiveCompactionOperation | null;
  let clearActiveOperationCalled: boolean;
  const workspaceId = "test-workspace";

  beforeEach(() => {
    const { emitter, events } = createMockEmitter();
    mockEmitter = emitter;
    emittedEvents = events;

    telemetryCapture = mock((_payload: TelemetryEventPayload) => {
      void _payload;
    });
    telemetryService = { capture: telemetryCapture } as unknown as TelemetryService;

    mockHistoryService = createMockHistoryService();
    mockPartialService = createMockPartialService();

    // Default: no active compaction operation
    activeOperation = null;
    clearActiveOperationCalled = false;

    handler = new CompactionHandler({
      workspaceId,
      historyService: mockHistoryService as unknown as HistoryService,
      telemetryService,
      partialService: mockPartialService as unknown as PartialService,
      emitter: mockEmitter,
      getActiveCompactionOperation: () => activeOperation,
      clearActiveCompactionOperation: () => {
        clearActiveOperationCalled = true;
        activeOperation = null;
      },
    });
  });

  /** Helper to set an active compaction operation */

  const getReplaceHistoryCalls = (): Array<[string, MuxMessage[]]> => {
    return mockHistoryService.replaceHistory.mock.calls as unknown as Array<[string, MuxMessage[]]>;
  };

  const getReplacedMessage = (): MuxMessage => {
    const calls = getReplaceHistoryCalls();
    const [, messages] = calls[0];
    return messages[0];
  };
  const setActiveOperation = (
    operationId: string,
    source: "user" | "force-compaction" | "idle-compaction" = "user",
    streamMessageId: string | null = "msg-id"
  ) => {
    activeOperation = { operationId, streamMessageId, source };
  };

  describe("handleCompletion() - Control-plane Compaction", () => {
    it("should ignore stream-end events that do not match the compaction stream messageId", async () => {
      // Active operation, but bound to a different stream
      setActiveOperation("op-1", "user", "different-message-id");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()]);

      const event = createStreamEndEvent(createValidSummary());
      const result = await handler.handleCompletion(event);

      // Not treated as compaction
      expect(result).toBe(false);
      expect(mockHistoryService.replaceHistory.mock.calls).toHaveLength(0);
    });
    it("should return false when no active compaction operation", async () => {
      // No active operation set
      const msg = createNormalUserMessage();
      mockHistoryService.mockGetHistory(Ok([msg]));

      const event = createStreamEndEvent(createValidSummary());
      const result = await handler.handleCompletion(event);

      expect(result).toBe(false);
      expect(mockHistoryService.replaceHistory.mock.calls).toHaveLength(0);
    });

    it("should capture compaction_completed telemetry on successful compaction", async () => {
      setActiveOperation("op-1");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()]);

      const event = createStreamEndEvent(createValidSummary(), {
        duration: 1500,
        // Prefer contextUsage (context size) over total usage.
        contextUsage: { inputTokens: 1000, outputTokens: 333, totalTokens: undefined },
      });

      await handler.handleCompletion(event);

      expect(telemetryCapture.mock.calls).toHaveLength(1);
      const payload = telemetryCapture.mock.calls[0][0] as TelemetryEventPayload;
      expect(payload.event).toBe("compaction_completed");
      if (payload.event !== "compaction_completed") {
        throw new Error("Expected compaction_completed payload");
      }

      expect(payload.properties).toEqual({
        model: "claude-3-5-sonnet-20241022",
        // 1.5s -> 2
        duration_b2: 2,
        // 1000 -> 1024
        input_tokens_b2: 1024,
        // 333 -> 512
        output_tokens_b2: 512,
        compaction_source: "manual",
      });
    });

    it("should return true when successful", async () => {
      setActiveOperation("op-1");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()]);

      const event = createStreamEndEvent(createValidSummary());
      const result = await handler.handleCompletion(event);

      expect(result).toBe(true);
      expect(clearActiveOperationCalled).toBe(true);
    });

    it("should extract and store summary text from event.parts", async () => {
      setActiveOperation("op-1");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()]);

      const validSummary = createValidSummary();
      const event = createStreamEndEvent(validSummary);
      await handler.handleCompletion(event);

      const replacedMsg = getReplacedMessage();
      expect((replacedMsg.parts[0] as { type: "text"; text: string }).text).toBe(validSummary);
    });

    it("should delete partial.json before clearing history (race condition fix)", async () => {
      setActiveOperation("op-1");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()]);

      const event = createStreamEndEvent(createValidSummary());
      await handler.handleCompletion(event);

      // deletePartial should be called once before clearHistory
      expect(mockPartialService.deletePartial.mock.calls).toHaveLength(1);
      expect(mockPartialService.deletePartial.mock.calls[0][0]).toBe(workspaceId);
    });

    it("should call replaceHistory()", async () => {
      setActiveOperation("op-1");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()]);

      const validSummary = createValidSummary();
      const event = createStreamEndEvent(validSummary);
      await handler.handleCompletion(event);

      const calls = getReplaceHistoryCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe(workspaceId);
      const replacedMsg = getReplacedMessage();
      expect(replacedMsg.role).toBe("assistant");
      expect((replacedMsg.parts[0] as { type: "text"; text: string }).text).toBe(validSummary);
    });

    it("should emit delete event for old messages", async () => {
      setActiveOperation("op-1");
      mockHistoryService.mockGetHistory(Ok([createNormalUserMessage()]));
      mockHistoryService.mockReplaceHistory(Ok([0, 1, 2, 3]));

      const event = createStreamEndEvent(createValidSummary());
      await handler.handleCompletion(event);

      const deleteEvent = emittedEvents.find(
        (_e) => (_e.data.message as { type?: string })?.type === "delete"
      );
      expect(deleteEvent).toBeDefined();
      const delMsg = deleteEvent?.data.message as { type: "delete"; historySequences: number[] };
      expect(delMsg.historySequences).toEqual([0, 1, 2, 3]);
    });

    it("should emit summary message with complete metadata", async () => {
      setActiveOperation("op-1");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()]);

      const usage = { inputTokens: 200, outputTokens: 100, totalTokens: 300 };
      const event = createStreamEndEvent(createValidSummary(), {
        model: "claude-3-5-sonnet-20241022",
        usage,
        duration: 2000,
        providerMetadata: { anthropic: { cacheCreationInputTokens: 50000 } },
        systemMessageTokens: 100,
      });
      await handler.handleCompletion(event);

      const summaryEvent = emittedEvents.find((_e) => {
        const m = _e.data.message as MuxMessage | undefined;
        return m?.role === "assistant" && m?.parts !== undefined;
      });
      expect(summaryEvent).toBeDefined();
      const sevt = summaryEvent?.data.message as MuxMessage;
      // providerMetadata is omitted to avoid inflating context with pre-compaction cacheCreationInputTokens
      expect(sevt.metadata).toMatchObject({
        model: "claude-3-5-sonnet-20241022",
        usage,
        duration: 2000,
        systemMessageTokens: 100,
        compacted: "user",
      });
      expect(sevt.metadata?.providerMetadata).toBeUndefined();
    });

    it("should emit stream-end event to frontend", async () => {
      setActiveOperation("op-1");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()]);

      const event = createStreamEndEvent(createValidSummary(), { duration: 1234 });
      await handler.handleCompletion(event);

      const streamEndEvent = emittedEvents.find((_e) => _e.data.message === event);
      expect(streamEndEvent).toBeDefined();
      expect(streamEndEvent?.data.workspaceId).toBe(workspaceId);
      const streamMsg = streamEndEvent?.data.message as StreamEndEvent;
      expect(streamMsg.metadata.duration).toBe(1234);
    });

    it("should set compacted in summary metadata", async () => {
      setActiveOperation("op-1");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()]);

      const event = createStreamEndEvent(createValidSummary());
      await handler.handleCompletion(event);

      const replacedMsg = getReplacedMessage();
      expect(replacedMsg.metadata?.compacted).toBe("user");
    });
  });

  describe("handleCompletion() - Summary Validation", () => {
    it("should reject empty summary and not clear history", async () => {
      setActiveOperation("op-1");
      mockHistoryService.mockGetHistory(Ok([createNormalUserMessage()]));

      const event = createStreamEndEvent("");
      const result = await handler.handleCompletion(event);

      expect(result).toBe(true); // Still returns true (was a compaction attempt)
      expect(mockHistoryService.replaceHistory.mock.calls).toHaveLength(0);
      expect(clearActiveOperationCalled).toBe(true);
    });

    it("should reject summary that is too short (<50 words)", async () => {
      setActiveOperation("op-1");
      mockHistoryService.mockGetHistory(Ok([createNormalUserMessage()]));

      // Only ~10 words
      const event = createStreamEndEvent(
        "This is a very short summary that won't pass validation."
      );
      const result = await handler.handleCompletion(event);

      expect(result).toBe(true);
      expect(mockHistoryService.replaceHistory.mock.calls).toHaveLength(0);
      expect(clearActiveOperationCalled).toBe(true);
    });

    it("should accept summary at minimum word count", async () => {
      setActiveOperation("op-1");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()]);

      // Exactly 50 words
      const fiftyWords = Array(50).fill("word").join(" ");
      const event = createStreamEndEvent(fiftyWords);
      const result = await handler.handleCompletion(event);

      expect(result).toBe(true);
      expect(mockHistoryService.replaceHistory.mock.calls).toHaveLength(1);
    });
  });

  describe("handleCompletion() - Deduplication", () => {
    it("should track processed operation IDs", async () => {
      setActiveOperation("op-unique");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()], [0]);

      const event = createStreamEndEvent(createValidSummary());
      await handler.handleCompletion(event);

      expect(mockHistoryService.replaceHistory.mock.calls).toHaveLength(1);
    });

    it("should return true without re-processing when same operation ID seen twice", async () => {
      setActiveOperation("op-dupe");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()], [0]);

      const event = createStreamEndEvent(createValidSummary());
      const result1 = await handler.handleCompletion(event);

      // Re-set operation since it was cleared
      setActiveOperation("op-dupe");
      const result2 = await handler.handleCompletion(event);

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(mockHistoryService.replaceHistory.mock.calls).toHaveLength(1);
    });

    it("should not emit duplicate events", async () => {
      setActiveOperation("op-dupe-2");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()], [0]);

      const event = createStreamEndEvent(createValidSummary());
      await handler.handleCompletion(event);
      const eventCountAfterFirst = emittedEvents.length;

      // Re-set operation since it was cleared
      setActiveOperation("op-dupe-2");
      await handler.handleCompletion(event);
      const eventCountAfterSecond = emittedEvents.length;

      expect(eventCountAfterSecond).toBe(eventCountAfterFirst);
    });

    it("should not clear history twice", async () => {
      setActiveOperation("op-dupe-3");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()], [0]);

      const event = createStreamEndEvent(createValidSummary());
      await handler.handleCompletion(event);

      // Re-set operation since it was cleared
      setActiveOperation("op-dupe-3");
      await handler.handleCompletion(event);

      expect(mockHistoryService.replaceHistory.mock.calls).toHaveLength(1);
    });
  });

  describe("Error Handling", () => {
    it("should return true but not replace history when replaceHistory() fails", async () => {
      setActiveOperation("op-1");
      mockHistoryService.mockGetHistory(Ok([createNormalUserMessage()]));
      mockHistoryService.mockReplaceHistory(Err("Replace failed"));

      const event = createStreamEndEvent(createValidSummary());
      const result = await handler.handleCompletion(event);

      // Returns true because it was a compaction attempt (even though it failed)
      expect(result).toBe(true);
      expect(mockHistoryService.replaceHistory.mock.calls).toHaveLength(1);
      expect(clearActiveOperationCalled).toBe(true);

      // Should not emit summary/delete events on failure
      const summaryEvent = emittedEvents.find((_e) => {
        const m = _e.data.message as MuxMessage | undefined;
        return m?.role === "assistant" && m?.parts !== undefined;
      });
      expect(summaryEvent).toBeUndefined();
    });

    it("should log errors but not throw", async () => {
      setActiveOperation("op-1");
      mockHistoryService.mockGetHistory(Ok([createNormalUserMessage()]));
      mockHistoryService.mockReplaceHistory(Err("Database corruption"));

      const event = createStreamEndEvent(createValidSummary());

      // Should not throw
      const result = await handler.handleCompletion(event);
      expect(result).toBe(true);
    });

    it("should emit stream-end even when compaction fails", async () => {
      setActiveOperation("op-1");
      mockHistoryService.mockGetHistory(Ok([createNormalUserMessage()]));
      mockHistoryService.mockReplaceHistory(Err("Replace failed"));

      const event = createStreamEndEvent(createValidSummary());
      await handler.handleCompletion(event);

      // stream-end should be emitted so UI updates
      const streamEndEvent = emittedEvents.find((_e) => _e.data.message === event);
      expect(streamEndEvent).toBeDefined();
    });
  });

  describe("Event Emission", () => {
    it("should include workspaceId in all chat-event emissions", async () => {
      setActiveOperation("op-1");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()]);

      const event = createStreamEndEvent(createValidSummary());
      await handler.handleCompletion(event);

      const chatEvents = emittedEvents.filter((e) => e.event === "chat-event");
      expect(chatEvents.length).toBeGreaterThan(0);
      chatEvents.forEach((e) => {
        expect(e.data.workspaceId).toBe(workspaceId);
      });
    });

    it("should emit DeleteMessage with correct type and historySequences array", async () => {
      setActiveOperation("op-1");
      mockHistoryService.mockGetHistory(Ok([createNormalUserMessage()]));
      mockHistoryService.mockReplaceHistory(Ok([5, 10, 15]));

      const event = createStreamEndEvent(createValidSummary());
      await handler.handleCompletion(event);

      const deleteEvent = emittedEvents.find(
        (_e) => (_e.data.message as { type?: string })?.type === "delete"
      );
      expect(deleteEvent?.data.message).toEqual({
        type: "delete",
        historySequences: [5, 10, 15],
      });
    });

    it("should emit summary message with proper MuxMessage structure", async () => {
      setActiveOperation("op-1");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()]);

      const validSummary = createValidSummary();
      const event = createStreamEndEvent(validSummary);
      await handler.handleCompletion(event);

      const summaryEvent = emittedEvents.find((_e) => {
        const m = _e.data.message as MuxMessage | undefined;
        return m?.role === "assistant" && m?.parts !== undefined;
      });
      expect(summaryEvent).toBeDefined();
      const summaryMsg = summaryEvent?.data.message as MuxMessage;
      expect(summaryMsg).toMatchObject({
        id: expect.stringContaining("summary-") as string,
        role: "assistant",
        parts: [{ type: "text", text: validSummary }],
        metadata: expect.objectContaining({
          compacted: "user",
          muxMetadata: { type: "normal" },
        }) as MuxMessage["metadata"],
      });
    });

    it("should forward stream events (stream-end, stream-abort) correctly", async () => {
      setActiveOperation("op-1");
      setupSuccessfulCompaction(mockHistoryService, [createNormalUserMessage()]);

      const event = createStreamEndEvent(createValidSummary(), { customField: "test" });
      await handler.handleCompletion(event);

      const streamEndEvent = emittedEvents.find((_e) => _e.data.message === event);
      expect(streamEndEvent).toBeDefined();
      const streamMsg = streamEndEvent?.data.message as StreamEndEvent;
      expect((streamMsg.metadata as Record<string, unknown>).customField).toBe("test");
    });
  });

  describe("Idle Compaction", () => {
    it("should preserve original recency timestamp from last user message", async () => {
      const originalTimestamp = Date.now() - 3600 * 1000; // 1 hour ago
      const userMessage = createMuxMessage("user-1", "user", "Hello", {
        timestamp: originalTimestamp,
        historySequence: 0,
      });

      setActiveOperation("op-idle", "idle-compaction");
      mockHistoryService.mockGetHistory(Ok([userMessage]));
      mockHistoryService.mockReplaceHistory(Ok([0]));

      const event = createStreamEndEvent(createValidSummary());
      await handler.handleCompletion(event);

      const summaryEvent = emittedEvents.find((_e) => {
        const m = _e.data.message as MuxMessage | undefined;
        return m?.role === "assistant" && m?.metadata?.compacted;
      });
      expect(summaryEvent).toBeDefined();
      const summaryMsg = summaryEvent?.data.message as MuxMessage;
      expect(summaryMsg.metadata?.timestamp).toBe(originalTimestamp);
      expect(summaryMsg.metadata?.compacted).toBe("idle");
    });

    it("should preserve recency from last compacted message if no user message", async () => {
      const compactedTimestamp = Date.now() - 7200 * 1000; // 2 hours ago
      const compactedMessage = createMuxMessage("compacted-1", "assistant", "Previous summary", {
        timestamp: compactedTimestamp,
        compacted: "user",
        historySequence: 0,
      });

      setActiveOperation("op-idle", "idle-compaction");
      mockHistoryService.mockGetHistory(Ok([compactedMessage]));
      mockHistoryService.mockReplaceHistory(Ok([0]));

      const event = createStreamEndEvent(createValidSummary());
      await handler.handleCompletion(event);

      const summaryEvent = emittedEvents.find((_e) => {
        const m = _e.data.message as MuxMessage | undefined;
        return m?.role === "assistant" && m?.metadata?.compacted === "idle";
      });
      expect(summaryEvent).toBeDefined();
      const summaryMsg = summaryEvent?.data.message as MuxMessage;
      expect(summaryMsg.metadata?.timestamp).toBe(compactedTimestamp);
    });

    it("should use max of user and compacted timestamps", async () => {
      const olderCompactedTimestamp = Date.now() - 7200 * 1000; // 2 hours ago
      const newerUserTimestamp = Date.now() - 3600 * 1000; // 1 hour ago
      const compactedMessage = createMuxMessage("compacted-1", "assistant", "Previous summary", {
        timestamp: olderCompactedTimestamp,
        compacted: "user",
        historySequence: 0,
      });
      const userMessage = createMuxMessage("user-1", "user", "Hello", {
        timestamp: newerUserTimestamp,
        historySequence: 1,
      });

      setActiveOperation("op-idle", "idle-compaction");
      mockHistoryService.mockGetHistory(Ok([compactedMessage, userMessage]));
      mockHistoryService.mockReplaceHistory(Ok([0, 1]));

      const event = createStreamEndEvent(createValidSummary());
      await handler.handleCompletion(event);

      const summaryEvent = emittedEvents.find((_e) => {
        const m = _e.data.message as MuxMessage | undefined;
        return m?.role === "assistant" && m?.metadata?.compacted === "idle";
      });
      expect(summaryEvent).toBeDefined();
      const summaryMsg = summaryEvent?.data.message as MuxMessage;
      // Should use the newer timestamp (user message)
      expect(summaryMsg.metadata?.timestamp).toBe(newerUserTimestamp);
    });

    it("should use current time for non-idle compaction (user source)", async () => {
      const oldTimestamp = Date.now() - 3600 * 1000; // 1 hour ago
      const userMessage = createMuxMessage("user-1", "user", "Hello", {
        timestamp: oldTimestamp,
        historySequence: 0,
      });

      // Regular compaction (not idle) - uses "user" source
      setActiveOperation("op-user", "user");
      mockHistoryService.mockGetHistory(Ok([userMessage]));
      mockHistoryService.mockReplaceHistory(Ok([0]));

      const beforeTime = Date.now();
      const event = createStreamEndEvent(createValidSummary());
      await handler.handleCompletion(event);
      const afterTime = Date.now();

      const summaryEvent = emittedEvents.find((_e) => {
        const m = _e.data.message as MuxMessage | undefined;
        return m?.role === "assistant" && m?.metadata?.compacted;
      });
      expect(summaryEvent).toBeDefined();
      const summaryMsg = summaryEvent?.data.message as MuxMessage;
      // Should use current time, not the old user message timestamp
      expect(summaryMsg.metadata?.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(summaryMsg.metadata?.timestamp).toBeLessThanOrEqual(afterTime);
      expect(summaryMsg.metadata?.compacted).toBe("user");
    });
  });
});
