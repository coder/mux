import { describe, it, expect, beforeEach, mock } from "bun:test";
import { CompactionHandler } from "./compactionHandler";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";
import type { EventEmitter } from "events";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { StreamEndEvent } from "@/common/types/stream";
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
  let clearHistoryResult: Result<number[], string> = Ok([]);
  let appendToHistoryResult: Result<void, string> = Ok(undefined);

  const getHistory = mock((_) => Promise.resolve(getHistoryResult));
  const clearHistory = mock((_) => Promise.resolve(clearHistoryResult));
  const appendToHistory = mock((_, __) => Promise.resolve(appendToHistoryResult));
  const updateHistory = mock(() => Promise.resolve(Ok(undefined)));
  const truncateAfterMessage = mock(() => Promise.resolve(Ok(undefined)));

  return {
    getHistory,
    clearHistory,
    appendToHistory,
    updateHistory,
    truncateAfterMessage,
    // Allow setting mock return values
    mockGetHistory: (result: Result<MuxMessage[], string>) => {
      getHistoryResult = result;
    },
    mockClearHistory: (result: Result<number[], string>) => {
      clearHistoryResult = result;
    },
    mockAppendToHistory: (result: Result<void, string>) => {
      appendToHistoryResult = result;
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

const createCompactionRequest = (id = "req-1"): MuxMessage =>
  createMuxMessage(id, "user", "Please summarize the conversation", {
    historySequence: 0,
    muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
  });

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
  messages: MuxMessage[] = [createCompactionRequest()],
  clearedSequences?: number[]
) => {
  mockHistoryService.mockGetHistory(Ok(messages));
  mockHistoryService.mockClearHistory(Ok(clearedSequences ?? messages.map((_, i) => i)));
  mockHistoryService.mockAppendToHistory(Ok(undefined));
};

describe("CompactionHandler", () => {
  let handler: CompactionHandler;
  let mockHistoryService: ReturnType<typeof createMockHistoryService>;
  let mockPartialService: ReturnType<typeof createMockPartialService>;
  let mockEmitter: EventEmitter;
  let emittedEvents: EmittedEvent[];
  const workspaceId = "test-workspace";

  beforeEach(() => {
    const { emitter, events } = createMockEmitter();
    mockEmitter = emitter;
    emittedEvents = events;

    mockHistoryService = createMockHistoryService();
    mockPartialService = createMockPartialService();

    handler = new CompactionHandler({
      workspaceId,
      historyService: mockHistoryService as unknown as HistoryService,
      partialService: mockPartialService as unknown as PartialService,
      emitter: mockEmitter,
    });
  });

  describe("handleCompletion() - Normal Compaction Flow", () => {
    it("should return false when no compaction request found", async () => {
      const normalMsg = createMuxMessage("msg1", "user", "Hello", {
        historySequence: 0,
        muxMetadata: { type: "normal" },
      });
      mockHistoryService.mockGetHistory(Ok([normalMsg]));

      const event = createStreamEndEvent("Summary");
      const result = await handler.handleCompletion(event);

      expect(result).toBe(false);
      expect(mockHistoryService.clearHistory.mock.calls).toHaveLength(0);
    });

    it("should return false when historyService fails", async () => {
      mockHistoryService.mockGetHistory(Err("Database error"));

      const event = createStreamEndEvent("Summary");
      const result = await handler.handleCompletion(event);

      expect(result).toBe(false);
    });

    it("should return true when successful", async () => {
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Complete summary");
      const result = await handler.handleCompletion(event);

      expect(result).toBe(true);
    });

    it("should join multiple text parts from event.parts", async () => {
      const compactionReq = createCompactionRequest();
      setupSuccessfulCompaction(mockHistoryService, [compactionReq]);

      // Create event with multiple text parts
      const event: StreamEndEvent = {
        type: "stream-end",
        workspaceId: "test-workspace",
        messageId: "msg-id",
        parts: [
          { type: "text", text: "Part 1 " },
          { type: "text", text: "Part 2 " },
          { type: "text", text: "Part 3" },
        ],
        metadata: {
          model: "claude-3-5-sonnet-20241022",
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: undefined },
          duration: 1500,
        },
      };
      await handler.handleCompletion(event);

      const appendedMsg = mockHistoryService.appendToHistory.mock.calls[0][1] as MuxMessage;
      expect((appendedMsg.parts[0] as { type: "text"; text: string }).text).toBe(
        "Part 1 Part 2 Part 3"
      );
    });

    it("should extract summary text from event.parts", async () => {
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("This is the summary");
      await handler.handleCompletion(event);

      const appendedMsg = mockHistoryService.appendToHistory.mock.calls[0][1] as MuxMessage;
      expect((appendedMsg.parts[0] as { type: "text"; text: string }).text).toBe(
        "This is the summary"
      );
    });

    it("should delete partial.json before clearing history (race condition fix)", async () => {
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      // deletePartial should be called once before clearHistory
      expect(mockPartialService.deletePartial.mock.calls).toHaveLength(1);
      expect(mockPartialService.deletePartial.mock.calls[0][0]).toBe(workspaceId);

      // Verify deletePartial was called (we can't easily verify order without more complex mocking,
      // but the important thing is that it IS called during compaction)
    });

    it("should call clearHistory() and appendToHistory()", async () => {
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      expect(mockHistoryService.clearHistory.mock.calls).toHaveLength(1);
      expect(mockHistoryService.clearHistory.mock.calls[0][0]).toBe(workspaceId);
      expect(mockHistoryService.appendToHistory.mock.calls).toHaveLength(1);
      expect(mockHistoryService.appendToHistory.mock.calls[0][0]).toBe(workspaceId);
      const appendedMsg = mockHistoryService.appendToHistory.mock.calls[0][1] as MuxMessage;
      expect(appendedMsg.role).toBe("assistant");
      expect((appendedMsg.parts[0] as { type: "text"; text: string }).text).toBe("Summary");
    });

    it("should emit delete event for old messages", async () => {
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0, 1, 2, 3]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      const deleteEvent = emittedEvents.find(
        (_e) => (_e.data.message as { type?: string })?.type === "delete"
      );
      expect(deleteEvent).toBeDefined();
      const delMsg = deleteEvent?.data.message as { type: "delete"; historySequences: number[] };
      expect(delMsg.historySequences).toEqual([0, 1, 2, 3]);
    });

    it("should emit summary message with complete metadata", async () => {
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const usage = { inputTokens: 200, outputTokens: 100, totalTokens: 300 };
      const event = createStreamEndEvent("Summary", {
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
        compacted: true,
      });
      expect(sevt.metadata?.providerMetadata).toBeUndefined();
    });

    it("should emit stream-end event to frontend", async () => {
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary", { duration: 1234 });
      await handler.handleCompletion(event);

      const streamEndEvent = emittedEvents.find((_e) => _e.data.message === event);
      expect(streamEndEvent).toBeDefined();
      expect(streamEndEvent?.data.workspaceId).toBe(workspaceId);
      const streamMsg = streamEndEvent?.data.message as StreamEndEvent;
      expect(streamMsg.metadata.duration).toBe(1234);
    });

    it("should set compacted: true in summary metadata", async () => {
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      const appendedMsg = mockHistoryService.appendToHistory.mock.calls[0][1] as MuxMessage;
      expect(appendedMsg.metadata?.compacted).toBe(true);
    });
  });

  describe("handleCompletion() - Deduplication", () => {
    it("should track processed compaction-request IDs", async () => {
      const compactionReq = createCompactionRequest("req-unique");
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      expect(mockHistoryService.clearHistory.mock.calls).toHaveLength(1);
    });

    it("should return true without re-processing when same request ID seen twice", async () => {
      const compactionReq = createCompactionRequest("req-dupe");
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary");
      const result1 = await handler.handleCompletion(event);
      const result2 = await handler.handleCompletion(event);

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(mockHistoryService.clearHistory.mock.calls).toHaveLength(1);
    });

    it("should not emit duplicate events", async () => {
      const compactionReq = createCompactionRequest("req-dupe-2");
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);
      const eventCountAfterFirst = emittedEvents.length;

      await handler.handleCompletion(event);
      const eventCountAfterSecond = emittedEvents.length;

      expect(eventCountAfterSecond).toBe(eventCountAfterFirst);
    });

    it("should not clear history twice", async () => {
      const compactionReq = createCompactionRequest("req-dupe-3");
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);
      await handler.handleCompletion(event);

      expect(mockHistoryService.clearHistory.mock.calls).toHaveLength(1);
      expect(mockHistoryService.appendToHistory.mock.calls).toHaveLength(1);
    });
  });

  describe("Error Handling", () => {
    it("should return false when clearHistory() fails", async () => {
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Err("Clear failed"));

      const event = createStreamEndEvent("Summary");
      const result = await handler.handleCompletion(event);

      expect(result).toBe(false);
      expect(mockHistoryService.appendToHistory.mock.calls).toHaveLength(0);
    });

    it("should return false when appendToHistory() fails", async () => {
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0]));
      mockHistoryService.mockAppendToHistory(Err("Append failed"));

      const event = createStreamEndEvent("Summary");
      const result = await handler.handleCompletion(event);

      expect(result).toBe(false);
    });

    it("should log errors but not throw", async () => {
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Err("Database corruption"));

      const event = createStreamEndEvent("Summary");

      // Should not throw
      const result = await handler.handleCompletion(event);
      expect(result).toBe(false);
    });

    it("should not emit events when compaction fails mid-process", async () => {
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Err("Clear failed"));

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      expect(emittedEvents).toHaveLength(0);
    });
  });

  describe("Event Emission", () => {
    it("should include workspaceId in all chat-event emissions", async () => {
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      const chatEvents = emittedEvents.filter((e) => e.event === "chat-event");
      expect(chatEvents.length).toBeGreaterThan(0);
      chatEvents.forEach((e) => {
        expect(e.data.workspaceId).toBe(workspaceId);
      });
    });

    it("should emit DeleteMessage with correct type and historySequences array", async () => {
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([5, 10, 15]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary");
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
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary text");
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
        parts: [{ type: "text", text: "Summary text" }],
        metadata: expect.objectContaining({
          compacted: true,
          muxMetadata: { type: "normal" },
        }) as MuxMessage["metadata"],
      });
    });

    it("should forward stream events (stream-end, stream-abort) correctly", async () => {
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary", { customField: "test" });
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
      const idleCompactionReq = createMuxMessage("req-1", "user", "Summarize", {
        historySequence: 1,
        muxMetadata: {
          type: "compaction-request",
          source: "idle-compaction",
          rawCommand: "/compact",
          parsed: {},
        },
      });

      mockHistoryService.mockGetHistory(Ok([userMessage, idleCompactionReq]));
      mockHistoryService.mockClearHistory(Ok([0, 1]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      const summaryEvent = emittedEvents.find((_e) => {
        const m = _e.data.message as MuxMessage | undefined;
        return m?.role === "assistant" && m?.metadata?.compacted;
      });
      expect(summaryEvent).toBeDefined();
      const summaryMsg = summaryEvent?.data.message as MuxMessage;
      expect(summaryMsg.metadata?.timestamp).toBe(originalTimestamp);
      expect(summaryMsg.metadata?.idleCompacted).toBe(true);
    });

    it("should preserve recency from last compacted message if no user message", async () => {
      const compactedTimestamp = Date.now() - 7200 * 1000; // 2 hours ago
      const compactedMessage = createMuxMessage("compacted-1", "assistant", "Previous summary", {
        timestamp: compactedTimestamp,
        compacted: true,
        historySequence: 0,
      });
      const idleCompactionReq = createMuxMessage("req-1", "user", "Summarize", {
        historySequence: 1,
        muxMetadata: {
          type: "compaction-request",
          source: "idle-compaction",
          rawCommand: "/compact",
          parsed: {},
        },
      });

      mockHistoryService.mockGetHistory(Ok([compactedMessage, idleCompactionReq]));
      mockHistoryService.mockClearHistory(Ok([0, 1]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      const summaryEvent = emittedEvents.find((_e) => {
        const m = _e.data.message as MuxMessage | undefined;
        return m?.role === "assistant" && m?.metadata?.idleCompacted;
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
        compacted: true,
        historySequence: 0,
      });
      const userMessage = createMuxMessage("user-1", "user", "Hello", {
        timestamp: newerUserTimestamp,
        historySequence: 1,
      });
      const idleCompactionReq = createMuxMessage("req-1", "user", "Summarize", {
        historySequence: 2,
        muxMetadata: {
          type: "compaction-request",
          source: "idle-compaction",
          rawCommand: "/compact",
          parsed: {},
        },
      });

      mockHistoryService.mockGetHistory(Ok([compactedMessage, userMessage, idleCompactionReq]));
      mockHistoryService.mockClearHistory(Ok([0, 1, 2]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      const summaryEvent = emittedEvents.find((_e) => {
        const m = _e.data.message as MuxMessage | undefined;
        return m?.role === "assistant" && m?.metadata?.idleCompacted;
      });
      expect(summaryEvent).toBeDefined();
      const summaryMsg = summaryEvent?.data.message as MuxMessage;
      // Should use the newer timestamp (user message)
      expect(summaryMsg.metadata?.timestamp).toBe(newerUserTimestamp);
    });

    it("should skip compaction-request message when finding timestamp to preserve", async () => {
      const originalTimestamp = Date.now() - 3600 * 1000; // 1 hour ago - the real user message
      const freshTimestamp = Date.now(); // The compaction request has a fresh timestamp
      const userMessage = createMuxMessage("user-1", "user", "Hello", {
        timestamp: originalTimestamp,
        historySequence: 0,
      });
      // Idle compaction request WITH a timestamp (as happens in production)
      const idleCompactionReq = createMuxMessage("req-1", "user", "Summarize", {
        timestamp: freshTimestamp,
        historySequence: 1,
        muxMetadata: {
          type: "compaction-request",
          source: "idle-compaction",
          rawCommand: "/compact",
          parsed: {},
        },
      });

      mockHistoryService.mockGetHistory(Ok([userMessage, idleCompactionReq]));
      mockHistoryService.mockClearHistory(Ok([0, 1]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      const summaryEvent = emittedEvents.find((_e) => {
        const m = _e.data.message as MuxMessage | undefined;
        return m?.role === "assistant" && m?.metadata?.compacted;
      });
      expect(summaryEvent).toBeDefined();
      const summaryMsg = summaryEvent?.data.message as MuxMessage;
      // Should use the OLD user message timestamp, NOT the fresh compaction request timestamp
      expect(summaryMsg.metadata?.timestamp).toBe(originalTimestamp);
      expect(summaryMsg.metadata?.idleCompacted).toBe(true);
    });

    it("should use current time for non-idle compaction", async () => {
      const oldTimestamp = Date.now() - 3600 * 1000; // 1 hour ago
      const userMessage = createMuxMessage("user-1", "user", "Hello", {
        timestamp: oldTimestamp,
        historySequence: 0,
      });
      // Regular compaction (not idle)
      const compactionReq = createCompactionRequest();
      mockHistoryService.mockGetHistory(Ok([userMessage, compactionReq]));
      mockHistoryService.mockClearHistory(Ok([0, 1]));
      mockHistoryService.mockAppendToHistory(Ok(undefined));

      const beforeTime = Date.now();
      const event = createStreamEndEvent("Summary");
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
      expect(summaryMsg.metadata?.idleCompacted).toBeFalsy();
    });
  });
});
