import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { CompactionHandler } from "./compactionHandler";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { EventEmitter } from "events";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { StreamEndEvent } from "@/common/types/stream";
import type { TelemetryService } from "./telemetryService";
import type { TelemetryEventPayload } from "@/common/telemetry/payload";
import { Ok, Err } from "@/common/types/result";

interface EmittedEvent {
  event: string;
  data: ChatEventData;
}

// Type guards for emitted events
interface ChatEventData {
  workspaceId: string;
  message: unknown;
}

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

const createSuccessfulFileEditMessage = (
  id: string,
  filePath: string,
  diff: string,
  metadata?: MuxMessage["metadata"]
): MuxMessage => ({
  id,
  role: "assistant",
  parts: [
    {
      type: "dynamic-tool",
      toolCallId: `tool-${id}`,
      toolName: "file_edit_replace_string",
      state: "output-available",
      input: { path: filePath },
      output: { success: true, diff },
    },
  ],
  metadata: {
    timestamp: 1234,
    ...(metadata ?? {}),
  },
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

const getEmittedStreamEndEvent = (events: EmittedEvent[]): StreamEndEvent | undefined => {
  return events
    .map((event) => event.data.message)
    .find((message): message is StreamEndEvent => {
      return (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as { type?: unknown }).type === "stream-end"
      );
    });
};

describe("CompactionHandler", () => {
  let handler: CompactionHandler;
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;
  let mockEmitter: EventEmitter;
  let telemetryCapture: ReturnType<typeof mock>;
  let telemetryService: TelemetryService;
  let sessionDir: string;
  let emittedEvents: EmittedEvent[];
  const workspaceId = "test-workspace";

  // Helper: seed messages into real history and return spies for tracking handler calls.
  // Spies are created AFTER seeding so they only track handler-initiated calls.
  const seedHistory = async (...messages: MuxMessage[]) => {
    for (const msg of messages) {
      const result = await historyService.appendToHistory(workspaceId, msg);
      if (!result.success) throw new Error(`Seed failed: ${result.error}`);
    }
    return {
      appendSpy: spyOn(historyService, "appendToHistory"),
      clearSpy: spyOn(historyService, "clearHistory"),
      updateSpy: spyOn(historyService, "updateHistory"),
    };
  };

  beforeEach(async () => {
    const testHistory = await createTestHistoryService();
    historyService = testHistory.historyService;
    cleanup = testHistory.cleanup;

    const { emitter, events } = createMockEmitter();
    mockEmitter = emitter;
    emittedEvents = events;

    telemetryCapture = mock((_payload: TelemetryEventPayload) => {
      void _payload;
    });
    telemetryService = { capture: telemetryCapture } as unknown as TelemetryService;

    sessionDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-compaction-handler-"));

    handler = new CompactionHandler({
      workspaceId,
      historyService,
      sessionDir,
      telemetryService,
      emitter: mockEmitter,
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("handleCompletion() - Normal Compaction Flow", () => {
    it("should return false when no compaction request found", async () => {
      const normalMsg = createMuxMessage("msg1", "user", "Hello", {
        historySequence: 0,
        muxMetadata: { type: "normal" },
      });
      const { clearSpy } = await seedHistory(normalMsg);

      const event = createStreamEndEvent("Summary");
      const result = await handler.handleCompletion(event);

      expect(result).toBe(false);
      expect(clearSpy.mock.calls).toHaveLength(0);
    });

    it("should return false when historyService fails", async () => {
      spyOn(historyService, "getLastMessages").mockResolvedValueOnce(Err("Database error"));

      const event = createStreamEndEvent("Summary");
      const result = await handler.handleCompletion(event);

      expect(result).toBe(false);
    });

    it("should capture compaction_completed telemetry on successful compaction", async () => {
      const compactionReq = createCompactionRequest();
      await seedHistory(compactionReq);

      const event = createStreamEndEvent("Summary", {
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

    it("persists pending diffs to disk and reloads them on restart", async () => {
      const compactionReq = createCompactionRequest();

      const fileEditMessage = createSuccessfulFileEditMessage(
        "assistant-edit",
        "/tmp/foo.ts",
        "@@ -1 +1 @@\n-foo\n+bar\n"
      );

      await seedHistory(fileEditMessage, compactionReq);

      const event = createStreamEndEvent("Summary");
      const handled = await handler.handleCompletion(event);
      expect(handled).toBe(true);

      const persistedPath = path.join(sessionDir, "post-compaction.json");
      const raw = await fsPromises.readFile(persistedPath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: unknown; diffs?: unknown };
      expect(parsed.version).toBe(1);

      const diffs = (parsed as { diffs?: Array<{ path: string; diff: string }> }).diffs;
      expect(Array.isArray(diffs)).toBe(true);
      if (Array.isArray(diffs)) {
        expect(diffs[0]?.path).toBe("/tmp/foo.ts");
        expect(diffs[0]?.diff).toContain("@@ -1 +1 @@");
      }

      // Simulate a restart: create a new handler and load from disk.
      const { emitter: newEmitter } = createMockEmitter();
      const reloaded = new CompactionHandler({
        workspaceId,
        historyService,
        sessionDir,
        telemetryService,
        emitter: newEmitter,
      });

      const pending = await reloaded.peekPendingDiffs();
      expect(pending).not.toBeNull();
      expect(pending?.[0]?.path).toBe("/tmp/foo.ts");

      await reloaded.ackPendingDiffsConsumed();

      let exists = true;
      try {
        await fsPromises.stat(persistedPath);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });

    it("persists only latest-epoch diffs when a durable compaction boundary exists", async () => {
      const staleEditMessage = createSuccessfulFileEditMessage(
        "assistant-stale-edit",
        "/tmp/stale.ts",
        "@@ -1 +1 @@\n-old\n+stale\n",
        { historySequence: 0 }
      );
      const latestBoundary = createMuxMessage("summary-boundary", "assistant", "Older summary", {
        historySequence: 1,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      });
      const recentEditMessage = createSuccessfulFileEditMessage(
        "assistant-recent-edit",
        "/tmp/recent.ts",
        "@@ -1 +1 @@\n-before\n+after\n",
        { historySequence: 2 }
      );
      const compactionReq = createMuxMessage("req-latest-epoch", "user", "Please summarize", {
        historySequence: 3,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      });

      await seedHistory(staleEditMessage, latestBoundary, recentEditMessage, compactionReq);

      const handled = await handler.handleCompletion(createStreamEndEvent("Summary"));
      expect(handled).toBe(true);

      const pending = await handler.peekPendingDiffs();
      expect(pending?.map((diff) => diff.path)).toEqual(["/tmp/recent.ts"]);

      const persistedPath = path.join(sessionDir, "post-compaction.json");
      const raw = await fsPromises.readFile(persistedPath, "utf-8");
      const parsed = JSON.parse(raw) as { diffs?: Array<{ path: string }> };
      expect(parsed.diffs?.map((diff) => diff.path)).toEqual(["/tmp/recent.ts"]);
    });

    it("falls back to full-history diff extraction when boundary marker is malformed", async () => {
      const staleEditMessage = createSuccessfulFileEditMessage(
        "assistant-stale-edit",
        "/tmp/stale.ts",
        "@@ -1 +1 @@\n-old\n+stale\n",
        { historySequence: 0 }
      );
      const malformedBoundaryMissingEpoch = createMuxMessage(
        "summary-malformed-boundary",
        "assistant",
        "Malformed summary",
        {
          historySequence: 1,
          compacted: "user",
          compactionBoundary: true,
          // Missing compactionEpoch should be treated as malformed and ignored.
        }
      );
      const recentEditMessage = createSuccessfulFileEditMessage(
        "assistant-recent-edit",
        "/tmp/recent.ts",
        "@@ -1 +1 @@\n-before\n+after\n",
        { historySequence: 2 }
      );
      const compactionReq = createMuxMessage("req-malformed-boundary", "user", "Please summarize", {
        historySequence: 3,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      });

      await seedHistory(
        staleEditMessage,
        malformedBoundaryMissingEpoch,
        recentEditMessage,
        compactionReq
      );

      const handled = await handler.handleCompletion(createStreamEndEvent("Summary"));
      expect(handled).toBe(true);

      const pending = await handler.peekPendingDiffs();
      expect(pending?.map((diff) => diff.path)).toEqual(["/tmp/recent.ts", "/tmp/stale.ts"]);

      const persistedPath = path.join(sessionDir, "post-compaction.json");
      const raw = await fsPromises.readFile(persistedPath, "utf-8");
      const parsed = JSON.parse(raw) as { diffs?: Array<{ path: string }> };
      expect(parsed.diffs?.map((diff) => diff.path)).toEqual(["/tmp/recent.ts", "/tmp/stale.ts"]);
    });
    it("should return true when successful", async () => {
      const compactionReq = createCompactionRequest();
      await seedHistory(compactionReq);

      const event = createStreamEndEvent("Complete summary");
      const result = await handler.handleCompletion(event);

      expect(result).toBe(true);
    });

    it("should join multiple text parts from event.parts", async () => {
      const compactionReq = createCompactionRequest();
      const { appendSpy } = await seedHistory(compactionReq);

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

      const appendedMsg = appendSpy.mock.calls[0][1];
      expect((appendedMsg.parts[0] as { type: "text"; text: string }).text).toBe(
        "Part 1 Part 2 Part 3"
      );
    });

    it("should extract summary text from event.parts", async () => {
      const compactionReq = createCompactionRequest();
      const { appendSpy } = await seedHistory(compactionReq);

      const event = createStreamEndEvent("This is the summary");
      await handler.handleCompletion(event);

      const appendedMsg = appendSpy.mock.calls[0][1];
      expect((appendedMsg.parts[0] as { type: "text"; text: string }).text).toBe(
        "This is the summary"
      );
    });

    it("should delete partial.json before appending summary (race condition fix)", async () => {
      const compactionReq = createCompactionRequest();
      await seedHistory(compactionReq);
      const deletePartialSpy = spyOn(historyService, "deletePartial");

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      // deletePartial should be called once before appendToHistory
      expect(deletePartialSpy.mock.calls).toHaveLength(1);
      expect(deletePartialSpy.mock.calls[0][0]).toBe(workspaceId);

      // Verify deletePartial was called (we can't easily verify order without more complex mocking,
      // but the important thing is that it IS called during compaction)
    });

    it("should append summary without clearing history", async () => {
      const compactionReq = createCompactionRequest();
      const { appendSpy, clearSpy } = await seedHistory(compactionReq);

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      expect(clearSpy.mock.calls).toHaveLength(0);
      expect(appendSpy.mock.calls).toHaveLength(1);
      expect(appendSpy.mock.calls[0][0]).toBe(workspaceId);
      const appendedMsg = appendSpy.mock.calls[0][1];
      expect(appendedMsg.role).toBe("assistant");
      expect((appendedMsg.parts[0] as { type: "text"; text: string }).text).toBe("Summary");
    });

    it("should not emit delete events when compaction is append-only", async () => {
      const compactionReq = createCompactionRequest();
      await seedHistory(compactionReq);

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      const deleteEvent = emittedEvents.find(
        (_e) => (_e.data.message as { type?: string })?.type === "delete"
      );
      expect(deleteEvent).toBeUndefined();
    });

    it("should emit summary message with complete metadata", async () => {
      const compactionReq = createCompactionRequest();
      await seedHistory(compactionReq);

      const usage = {
        inputTokens: 200,
        outputTokens: 100,
        reasoningTokens: 30,
        totalTokens: 300,
      };
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
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
        contextUsage: {
          // 100 system prompt tokens + (100 output - 30 reasoning) summary tokens
          inputTokens: 170,
          outputTokens: 0,
          totalTokens: 170,
        },
      });
      expect(sevt.metadata?.providerMetadata).toBeUndefined();
    });

    it("falls back to contextUsage and provider reasoning metadata when total usage is unavailable", async () => {
      const compactionReq = createCompactionRequest();
      await seedHistory(compactionReq);

      const event = createStreamEndEvent("Summary", {
        usage: undefined,
        contextUsage: {
          inputTokens: 9_000,
          outputTokens: 80,
          totalTokens: 9_080,
        },
        contextProviderMetadata: { openai: { reasoningTokens: 30 } },
        systemMessageTokens: 20,
      });

      const result = await handler.handleCompletion(event);
      expect(result).toBe(true);

      const summaryEvent = emittedEvents.find((_e) => {
        const m = _e.data.message as MuxMessage | undefined;
        return m?.role === "assistant" && m?.metadata?.compactionBoundary === true;
      });
      expect(summaryEvent).toBeDefined();
      const summaryMessage = summaryEvent?.data.message as MuxMessage;
      expect(summaryMessage.metadata?.contextUsage).toEqual({
        // 20 system prompt tokens + (80 output - 30 reasoning) summary tokens
        inputTokens: 70,
        outputTokens: 0,
        totalTokens: 70,
      });

      const streamMsg = getEmittedStreamEndEvent(emittedEvents);
      expect(streamMsg?.metadata.contextUsage).toEqual({
        inputTokens: 70,
        outputTokens: 0,
        totalTokens: 70,
      });
    });

    it("should emit stream-end event to frontend", async () => {
      const compactionReq = createCompactionRequest();
      await seedHistory(compactionReq);

      const event = createStreamEndEvent("Summary", { duration: 1234 });
      await handler.handleCompletion(event);

      const streamMsg = getEmittedStreamEndEvent(emittedEvents);
      expect(streamMsg).toBeDefined();
      expect(streamMsg?.workspaceId).toBe(workspaceId);
      expect(streamMsg?.metadata.duration).toBe(1234);
    });

    it("should set boundary metadata and keep historySequence monotonic", async () => {
      const priorMessage = createMuxMessage("user-1", "user", "Earlier", {
        historySequence: 4,
      });
      const compactionReq = createMuxMessage("req-1", "user", "Please summarize", {
        historySequence: 5,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      });
      const { appendSpy } = await seedHistory(priorMessage, compactionReq);

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      const appendedMsg = appendSpy.mock.calls[0][1];
      expect(appendedMsg.metadata?.compacted).toBe("user");
      expect(appendedMsg.metadata?.compactionBoundary).toBe(true);
      expect(appendedMsg.metadata?.compactionEpoch).toBe(1);
      expect(appendedMsg.metadata?.historySequence).toBe(6);
    });
    it("should ignore malformed persisted historySequence values when deriving monotonic bounds", async () => {
      const malformedNegativeSequence = createMuxMessage(
        "assistant-malformed-negative-sequence",
        "assistant",
        "Corrupted persisted metadata",
        {
          historySequence: -7,
        }
      );
      const malformedFractionalSequence = createMuxMessage(
        "assistant-malformed-fractional-sequence",
        "assistant",
        "Corrupted persisted metadata",
        {
          historySequence: 99.5,
        }
      );
      const priorMessage = createMuxMessage("user-1", "user", "Earlier", {
        historySequence: 4,
      });
      const compactionReq = createMuxMessage("req-1", "user", "Please summarize", {
        historySequence: 5,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      });

      // Seed valid messages so the service's sequence counter advances to 6,
      // then mock getLastMessages to inject the malformed messages alongside them.
      // The malformed historySequence values (-7, 99.5) would fail real appendToHistory assertions,
      // so they can only be introduced via the mocked read path.
      await historyService.appendToHistory(workspaceId, priorMessage);
      await historyService.appendToHistory(workspaceId, compactionReq);
      spyOn(historyService, "getLastMessages").mockResolvedValueOnce(
        Ok([malformedNegativeSequence, malformedFractionalSequence, priorMessage, compactionReq])
      );
      const appendSpy = spyOn(historyService, "appendToHistory");

      const event = createStreamEndEvent("Summary");
      const result = await handler.handleCompletion(event);

      expect(result).toBe(true);
      expect(appendSpy.mock.calls).toHaveLength(1);

      const appendedMsg = appendSpy.mock.calls[0][1];
      expect(appendedMsg.metadata?.historySequence).toBe(6);
      expect(appendedMsg.metadata?.compactionBoundary).toBe(true);
      expect(appendedMsg.metadata?.compactionEpoch).toBe(1);
    });

    it("should derive next compaction epoch from legacy compacted summaries", async () => {
      const legacySummary = createMuxMessage("summary-legacy", "assistant", "Older summary", {
        historySequence: 2,
        compacted: "user",
      });
      const compactionReq = createMuxMessage("req-epoch", "user", "Please summarize", {
        historySequence: 3,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      });

      const { appendSpy } = await seedHistory(legacySummary, compactionReq);

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      const appendedMsg = appendSpy.mock.calls[0][1];
      expect(appendedMsg.metadata?.compactionEpoch).toBe(2);
      expect(appendedMsg.metadata?.compactionBoundary).toBe(true);
      expect(appendedMsg.metadata?.historySequence).toBe(4);
    });

    it("should update streamed summaries in-place without carrying stale provider metadata", async () => {
      const compactionReq = createMuxMessage("req-streamed", "user", "Please summarize", {
        historySequence: 5,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      });
      const streamedSummary = createMuxMessage("msg-id", "assistant", "Summary", {
        historySequence: 6,
        timestamp: Date.now(),
        model: "claude-3-5-sonnet-20241022",
        providerMetadata: { anthropic: { cacheCreationInputTokens: 50_000 } },
        contextProviderMetadata: { anthropic: { cacheReadInputTokens: 10_000 } },
      });

      const { appendSpy, updateSpy } = await seedHistory(compactionReq, streamedSummary);

      const event = createStreamEndEvent("Summary");
      const result = await handler.handleCompletion(event);

      expect(result).toBe(true);
      expect(updateSpy.mock.calls).toHaveLength(1);
      expect(appendSpy.mock.calls).toHaveLength(0);

      const updatedSummary = updateSpy.mock.calls[0][1];
      expect(updatedSummary.id).toBe("msg-id");
      expect(updatedSummary.metadata?.historySequence).toBe(6);
      expect(updatedSummary.metadata?.compactionBoundary).toBe(true);
      expect(updatedSummary.metadata?.compactionEpoch).toBe(1);
      expect(updatedSummary.metadata?.contextUsage).toEqual({
        // 0 system prompt tokens + 50 summary output tokens
        inputTokens: 50,
        outputTokens: 0,
        totalTokens: 50,
      });
      expect(updatedSummary.metadata?.providerMetadata).toBeUndefined();
      expect(updatedSummary.metadata?.contextProviderMetadata).toBeUndefined();

      const summaryEvent = emittedEvents.find((_e) => {
        const m = _e.data.message as MuxMessage | undefined;
        return m?.id === "msg-id" && m?.metadata?.compactionBoundary === true;
      });
      expect(summaryEvent).toBeDefined();
    });

    it("should strip stale provider metadata from emitted stream-end when reusing streamed summary ID", async () => {
      const compactionReq = createMuxMessage("req-streamed-sanitize", "user", "Please summarize", {
        historySequence: 5,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      });
      const streamedSummary = createMuxMessage("msg-id", "assistant", "Summary", {
        historySequence: 6,
        timestamp: Date.now(),
        model: "claude-3-5-sonnet-20241022",
      });

      await seedHistory(compactionReq, streamedSummary);

      const event = createStreamEndEvent("Summary", {
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 20,
          totalTokens: 150,
        },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 50_000 } },
        contextProviderMetadata: { anthropic: { cacheReadInputTokens: 10_000 } },
        contextUsage: { inputTokens: 123_456, outputTokens: 99_999, totalTokens: undefined },
        systemMessageTokens: 75,
        customField: "preserved",
      });

      const result = await handler.handleCompletion(event);

      expect(result).toBe(true);
      const streamMsg = getEmittedStreamEndEvent(emittedEvents);
      expect(streamMsg).toBeDefined();
      expect(streamMsg?.messageId).toBe("msg-id");
      expect(streamMsg?.metadata.providerMetadata).toBeUndefined();
      expect(streamMsg?.metadata.contextProviderMetadata).toBeUndefined();
      expect(streamMsg?.metadata.contextUsage).toEqual({
        // 75 system prompt tokens + (50 output - 20 reasoning) summary tokens
        inputTokens: 105,
        outputTokens: 0,
        totalTokens: 105,
      });
      expect((streamMsg?.metadata as Record<string, unknown> | undefined)?.customField).toBe(
        "preserved"
      );
    });

    it("omits context usage estimate when stream-end metadata has no visible summary tokens", async () => {
      const compactionReq = createMuxMessage(
        "req-streamed-no-estimate",
        "user",
        "Please summarize",
        {
          historySequence: 5,
          muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
        }
      );
      const streamedSummary = createMuxMessage("msg-id", "assistant", "Summary", {
        historySequence: 6,
        timestamp: Date.now(),
        model: "claude-3-5-sonnet-20241022",
      });

      await seedHistory(compactionReq, streamedSummary);

      const event = createStreamEndEvent("Summary", {
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 20,
          totalTokens: 120,
        },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 50_000 } },
      });

      const result = await handler.handleCompletion(event);

      expect(result).toBe(true);
      const streamMsg = getEmittedStreamEndEvent(emittedEvents);
      expect(streamMsg).toBeDefined();
      expect(streamMsg?.metadata.contextUsage).toBeUndefined();
      expect(streamMsg?.metadata.providerMetadata).toBeUndefined();
    });

    it("should skip malformed compaction boundary markers when deriving next epoch", async () => {
      const validBoundary = createMuxMessage("summary-valid", "assistant", "Valid summary", {
        historySequence: 1,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 3,
      });
      const malformedBoundaryMissingEpoch = createMuxMessage(
        "summary-malformed-1",
        "assistant",
        "Malformed boundary",
        {
          historySequence: 2,
          compacted: "user",
          compactionBoundary: true,
        }
      );
      const malformedBoundaryMissingCompacted = createMuxMessage(
        "summary-malformed-2",
        "assistant",
        "Malformed boundary",
        {
          historySequence: 3,
          compactionBoundary: true,
          compactionEpoch: 99,
        }
      );
      const malformedBoundaryInvalidCompacted = createMuxMessage(
        "summary-malformed-invalid-compacted",
        "assistant",
        "Malformed boundary",
        {
          historySequence: 4,
          compactionBoundary: true,
          compactionEpoch: 200,
        }
      );
      if (malformedBoundaryInvalidCompacted.metadata) {
        (malformedBoundaryInvalidCompacted.metadata as Record<string, unknown>).compacted =
          "corrupted";
      }
      const malformedBoundaryInvalidEpoch = createMuxMessage(
        "summary-malformed-3",
        "assistant",
        "Malformed boundary",
        {
          historySequence: 4,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 0,
        }
      );
      const compactionReq = createMuxMessage("req-malformed", "user", "Please summarize", {
        historySequence: 5,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      });

      const { appendSpy } = await seedHistory(
        validBoundary,
        malformedBoundaryMissingEpoch,
        malformedBoundaryMissingCompacted,
        malformedBoundaryInvalidCompacted,
        malformedBoundaryInvalidEpoch,
        compactionReq
      );

      const result = await handler.handleCompletion(createStreamEndEvent("Summary"));

      expect(result).toBe(true);
      expect(appendSpy.mock.calls).toHaveLength(1);
      const appendedMsg = appendSpy.mock.calls[0][1];
      expect(appendedMsg.metadata?.compactionEpoch).toBe(4);
      expect(appendedMsg.metadata?.compactionBoundary).toBe(true);
    });
  });

  describe("handleCompletion() - Deduplication", () => {
    it("should track processed compaction-request IDs", async () => {
      const compactionReq = createCompactionRequest("req-unique");
      const { appendSpy, clearSpy } = await seedHistory(compactionReq);

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      expect(clearSpy.mock.calls).toHaveLength(0);
      expect(appendSpy.mock.calls).toHaveLength(1);
    });

    it("should return true without re-processing when same request ID seen twice", async () => {
      const compactionReq = createCompactionRequest("req-dupe");
      const { appendSpy, clearSpy } = await seedHistory(compactionReq);

      const event = createStreamEndEvent("Summary");
      const result1 = await handler.handleCompletion(event);
      const result2 = await handler.handleCompletion(event);

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(clearSpy.mock.calls).toHaveLength(0);
      expect(appendSpy.mock.calls).toHaveLength(1);
    });

    it("should not emit duplicate events", async () => {
      const compactionReq = createCompactionRequest("req-dupe-2");
      await seedHistory(compactionReq);

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);
      const eventCountAfterFirst = emittedEvents.length;

      await handler.handleCompletion(event);
      const eventCountAfterSecond = emittedEvents.length;

      expect(eventCountAfterSecond).toBe(eventCountAfterFirst);
    });

    it("should not append summary twice", async () => {
      const compactionReq = createCompactionRequest("req-dupe-3");
      const { appendSpy, clearSpy } = await seedHistory(compactionReq);

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);
      await handler.handleCompletion(event);

      expect(clearSpy.mock.calls).toHaveLength(0);
      expect(appendSpy.mock.calls).toHaveLength(1);
    });
  });

  describe("Error Handling", () => {
    it("should return false when appendToHistory() fails", async () => {
      const compactionReq = createCompactionRequest();
      const { appendSpy } = await seedHistory(compactionReq);
      appendSpy.mockResolvedValueOnce(Err("Append failed"));

      const event = createStreamEndEvent("Summary");
      const result = await handler.handleCompletion(event);

      expect(result).toBe(false);

      // Ensure we don't keep a persisted snapshot when summary append fails.
      const persistedPath = path.join(sessionDir, "post-compaction.json");
      let exists = true;
      try {
        await fsPromises.stat(persistedPath);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });

    it("should log errors but not throw", async () => {
      const compactionReq = createCompactionRequest();
      const { appendSpy } = await seedHistory(compactionReq);
      appendSpy.mockResolvedValueOnce(Err("Database corruption"));

      const event = createStreamEndEvent("Summary");

      // Should not throw
      const result = await handler.handleCompletion(event);
      expect(result).toBe(false);
    });

    it("should not emit events when compaction fails mid-process", async () => {
      const compactionReq = createCompactionRequest();
      const { appendSpy } = await seedHistory(compactionReq);
      appendSpy.mockResolvedValueOnce(Err("Append failed"));

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      expect(emittedEvents).toHaveLength(0);
    });
  });

  describe("Event Emission", () => {
    it("should include workspaceId in all chat-event emissions", async () => {
      const compactionReq = createCompactionRequest();
      await seedHistory(compactionReq);

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      const chatEvents = emittedEvents.filter((e) => e.event === "chat-event");
      expect(chatEvents.length).toBeGreaterThan(0);
      chatEvents.forEach((e) => {
        expect(e.data.workspaceId).toBe(workspaceId);
      });
    });

    it("should not emit DeleteMessage events during append-only compaction", async () => {
      const compactionReq = createCompactionRequest();
      await seedHistory(compactionReq);

      const event = createStreamEndEvent("Summary");
      await handler.handleCompletion(event);

      const deleteEvent = emittedEvents.find(
        (_e) => (_e.data.message as { type?: string })?.type === "delete"
      );
      expect(deleteEvent).toBeUndefined();
    });

    it("should emit summary message with proper MuxMessage structure", async () => {
      const compactionReq = createCompactionRequest();
      await seedHistory(compactionReq);

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
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 1,
          muxMetadata: { type: "compaction-summary" },
        }) as MuxMessage["metadata"],
      });
    });

    it("should forward stream events (stream-end, stream-abort) correctly", async () => {
      const compactionReq = createCompactionRequest();
      await seedHistory(compactionReq);

      const event = createStreamEndEvent("Summary", { customField: "test" });
      await handler.handleCompletion(event);

      const streamMsg = getEmittedStreamEndEvent(emittedEvents);
      expect(streamMsg).toBeDefined();
      expect((streamMsg?.metadata as Record<string, unknown> | undefined)?.customField).toBe(
        "test"
      );
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

      await seedHistory(userMessage, idleCompactionReq);

      const event = createStreamEndEvent("Summary");
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
      const idleCompactionReq = createMuxMessage("req-1", "user", "Summarize", {
        historySequence: 1,
        muxMetadata: {
          type: "compaction-request",
          source: "idle-compaction",
          rawCommand: "/compact",
          parsed: {},
        },
      });

      await seedHistory(compactedMessage, idleCompactionReq);

      const event = createStreamEndEvent("Summary");
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
      const idleCompactionReq = createMuxMessage("req-1", "user", "Summarize", {
        historySequence: 2,
        muxMetadata: {
          type: "compaction-request",
          source: "idle-compaction",
          rawCommand: "/compact",
          parsed: {},
        },
      });

      await seedHistory(compactedMessage, userMessage, idleCompactionReq);

      const event = createStreamEndEvent("Summary");
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

      await seedHistory(userMessage, idleCompactionReq);

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
      expect(summaryMsg.metadata?.compacted).toBe("idle");
    });

    it("should use current time for non-idle compaction", async () => {
      const oldTimestamp = Date.now() - 3600 * 1000; // 1 hour ago
      const userMessage = createMuxMessage("user-1", "user", "Hello", {
        timestamp: oldTimestamp,
        historySequence: 0,
      });
      // Regular compaction (not idle)
      const compactionReq = createCompactionRequest();
      await seedHistory(userMessage, compactionReq);

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
      expect(summaryMsg.metadata?.compacted).toBe("user");
    });
  });

  describe("Empty Summary Validation", () => {
    it("should reject compaction when summary is empty (stream crashed)", async () => {
      const compactionRequestMsg = createMuxMessage("compact-req-1", "user", "/compact", {
        historySequence: 0,
        timestamp: Date.now() - 1000,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      });
      const { appendSpy, clearSpy } = await seedHistory(compactionRequestMsg);

      // Empty parts array simulates stream crash before producing content
      const event = createStreamEndEvent("");

      const result = await handler.handleCompletion(event);

      // Should return false and NOT perform compaction
      expect(result).toBe(false);
      expect(clearSpy).not.toHaveBeenCalled();
      expect(appendSpy).not.toHaveBeenCalled();
    });

    it("should reject compaction when summary is only whitespace", async () => {
      const compactionRequestMsg = createMuxMessage("compact-req-1", "user", "/compact", {
        historySequence: 0,
        timestamp: Date.now() - 1000,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      });
      const { clearSpy } = await seedHistory(compactionRequestMsg);

      // Whitespace-only should also be rejected
      const event = createStreamEndEvent("   \n\t  ");

      const result = await handler.handleCompletion(event);

      expect(result).toBe(false);
      expect(clearSpy).not.toHaveBeenCalled();
    });
  });

  describe("Raw JSON Object Validation", () => {
    it("should reject compaction when summary is a raw JSON object", async () => {
      const compactionRequestMsg = createMuxMessage("compact-req-1", "user", "/compact", {
        historySequence: 0,
        timestamp: Date.now() - 1000,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      });
      const { appendSpy, clearSpy } = await seedHistory(compactionRequestMsg);

      // Any JSON object should be rejected - this catches all tool call leaks
      const jsonObject = JSON.stringify({
        script: "cd tpred && sed -n '405,520p' train/trainer.py",
        timeout_secs: 10,
        run_in_background: false,
        display_name: "Inspect trainer",
      });
      const event = createStreamEndEvent(jsonObject);

      const result = await handler.handleCompletion(event);

      // Should return false and NOT perform compaction
      expect(result).toBe(false);
      expect(clearSpy).not.toHaveBeenCalled();
      expect(appendSpy).not.toHaveBeenCalled();
    });

    it("should reject any JSON object regardless of structure", async () => {
      const compactionRequestMsg = createMuxMessage("compact-req-1", "user", "/compact", {
        historySequence: 0,
        timestamp: Date.now() - 1000,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      });
      await seedHistory(compactionRequestMsg);

      // Even arbitrary JSON objects should be rejected
      const arbitraryJson = JSON.stringify({
        foo: "bar",
        nested: { a: 1, b: 2 },
      });
      const event = createStreamEndEvent(arbitraryJson);

      const result = await handler.handleCompletion(event);
      expect(result).toBe(false);
    });

    it("should accept valid compaction summary text", async () => {
      const compactionRequestMsg = createMuxMessage("compact-req-1", "user", "/compact", {
        historySequence: 0,
        timestamp: Date.now() - 1000,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      });
      const { appendSpy, clearSpy } = await seedHistory(compactionRequestMsg);

      // Normal summary text
      const event = createStreamEndEvent(
        "The user was working on implementing a new feature. Key decisions included using TypeScript."
      );

      const result = await handler.handleCompletion(event);
      expect(result).toBe(true);
      expect(clearSpy).not.toHaveBeenCalled();
      expect(appendSpy).toHaveBeenCalled();
    });

    it("should accept summary with embedded JSON as part of prose", async () => {
      const compactionRequestMsg = createMuxMessage("compact-req-1", "user", "/compact", {
        historySequence: 0,
        timestamp: Date.now() - 1000,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      });
      await seedHistory(compactionRequestMsg);

      // Prose that contains JSON snippets is fine - only reject pure JSON objects
      const event = createStreamEndEvent(
        'The user configured {"apiKey": "xxx", "endpoint": "http://localhost"} in config.json.'
      );

      const result = await handler.handleCompletion(event);
      expect(result).toBe(true);
    });

    it("should not reject JSON arrays (only objects)", async () => {
      const compactionRequestMsg = createMuxMessage("compact-req-1", "user", "/compact", {
        historySequence: 0,
        timestamp: Date.now() - 1000,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      });
      await seedHistory(compactionRequestMsg);

      // Arrays are not tool calls, so they should pass (even though unusual)
      const event = createStreamEndEvent('["item1", "item2"]');

      const result = await handler.handleCompletion(event);
      expect(result).toBe(true);
    });
  });
});
