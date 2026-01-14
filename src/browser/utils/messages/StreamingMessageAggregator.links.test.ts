import { describe, it, expect, beforeEach } from "bun:test";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";
import type {
  StreamStartEvent,
  StreamDeltaEvent,
  StreamEndEvent,
  ToolCallStartEvent,
  ToolCallEndEvent,
} from "@/common/types/stream";

// Test without workspace ID to avoid localStorage dependency
const TEST_CREATED_AT = "2024-01-01T00:00:00.000Z";
const TEST_WORKSPACE_ID = "test-workspace";

// Helper to create stream-start event
function makeStreamStart(messageId: string, historySequence = 1): StreamStartEvent {
  return {
    type: "stream-start",
    workspaceId: TEST_WORKSPACE_ID,
    messageId,
    model: "test-model",
    historySequence,
    startTime: Date.now(),
  };
}

// Helper to create stream-delta event
function makeStreamDelta(messageId: string, delta: string, tokens = 10): StreamDeltaEvent {
  return {
    type: "stream-delta",
    workspaceId: TEST_WORKSPACE_ID,
    messageId,
    delta,
    tokens,
    timestamp: Date.now(),
  };
}

// Helper to create stream-end event
function makeStreamEnd(messageId: string): StreamEndEvent {
  return {
    type: "stream-end",
    workspaceId: TEST_WORKSPACE_ID,
    messageId,
    metadata: { model: "test-model" },
    parts: [],
  };
}

// Helper to create tool-call-start event
function makeToolCallStart(messageId: string, toolCallId: string): ToolCallStartEvent {
  return {
    type: "tool-call-start",
    workspaceId: TEST_WORKSPACE_ID,
    messageId,
    toolCallId,
    toolName: "bash",
    args: {},
    tokens: 0,
    timestamp: Date.now(),
  };
}

// Helper to create tool-call-end event
function makeToolCallEnd(messageId: string, toolCallId: string, result: unknown): ToolCallEndEvent {
  return {
    type: "tool-call-end",
    workspaceId: TEST_WORKSPACE_ID,
    messageId,
    toolCallId,
    toolName: "bash",
    result,
    timestamp: Date.now(),
  };
}

describe("StreamingMessageAggregator link detection", () => {
  let aggregator: StreamingMessageAggregator;

  beforeEach(() => {
    // Create aggregator without workspace ID to avoid localStorage
    aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
  });

  describe("getDetectedLinks", () => {
    it("returns empty array initially", () => {
      expect(aggregator.getDetectedLinks()).toEqual([]);
    });
  });

  describe("link extraction from complete parts", () => {
    it("extracts links after stream-end", () => {
      aggregator.handleStreamStart(makeStreamStart("msg1"));
      aggregator.handleStreamDelta(
        makeStreamDelta(
          "msg1",
          "I've opened a PR at https://github.com/owner/repo/pull/123 for review"
        )
      );

      // Links not extracted yet during streaming (URL could be split across deltas)
      expect(aggregator.getDetectedLinks()).toHaveLength(0);

      // Links extracted on stream-end when text part is complete
      aggregator.handleStreamEnd(makeStreamEnd("msg1"));

      const links = aggregator.getDetectedLinks();
      expect(links).toHaveLength(1);
      // All chat links are now generic (PR badge uses branch-based detection)
      expect(links[0]).toMatchObject({
        type: "generic",
        url: "https://github.com/owner/repo/pull/123",
      });
      // Should have metadata
      expect(links[0]?.detectedAt).toBeGreaterThan(0);
      expect(links[0]?.occurrenceCount).toBe(1);
    });

    it("extracts links from tool outputs during streaming", () => {
      aggregator.handleStreamStart(makeStreamStart("msg1"));
      aggregator.handleStreamDelta(makeStreamDelta("msg1", "Running checks..."));

      aggregator.handleToolCallStart(makeToolCallStart("msg1", "tool1"));
      aggregator.handleToolCallEnd(makeToolCallEnd("msg1", "tool1", "See https://example.com"));

      // Tool outputs are stable and should surface links immediately.
      const links = aggregator.getDetectedLinks();
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ type: "generic", url: "https://example.com" });
    });

    it("does not extract assistant text links until stream-end", () => {
      aggregator.handleStreamStart(makeStreamStart("msg1"));
      aggregator.handleStreamDelta(makeStreamDelta("msg1", "See https://example.com/docs"));

      aggregator.handleToolCallStart(makeToolCallStart("msg1", "tool1"));
      aggregator.handleToolCallEnd(makeToolCallEnd("msg1", "tool1", "no links"));

      // Still streaming - assistant text is considered unstable for link extraction.
      expect(aggregator.getDetectedLinks()).toHaveLength(0);

      aggregator.handleStreamEnd(makeStreamEnd("msg1"));
      expect(aggregator.getDetectedLinks().map((l) => l.url)).toContain("https://example.com/docs");
    });

    it("extracts generic links from assistant text", () => {
      aggregator.handleStreamStart(makeStreamStart("msg1"));
      aggregator.handleStreamDelta(
        makeStreamDelta("msg1", "Check out https://example.com/docs for more info")
      );
      aggregator.handleStreamEnd(makeStreamEnd("msg1"));

      const links = aggregator.getDetectedLinks();
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        type: "generic",
        url: "https://example.com/docs",
      });
      expect(links[0].detectedAt).toBeGreaterThan(0);
      expect(links[0].occurrenceCount).toBe(1);
    });

    it("deduplicates links in final message", () => {
      aggregator.handleStreamStart(makeStreamStart("msg1"));
      // Same link mentioned twice across deltas (will be merged into one text part)
      aggregator.handleStreamDelta(makeStreamDelta("msg1", "See https://example.com", 5));
      aggregator.handleStreamDelta(
        makeStreamDelta("msg1", " and also https://example.com again", 5)
      );
      aggregator.handleStreamEnd(makeStreamEnd("msg1"));

      const links = aggregator.getDetectedLinks();
      expect(links).toHaveLength(1);
    });

    it("extracts multiple distinct links", () => {
      aggregator.handleStreamStart(makeStreamStart("msg1"));
      aggregator.handleStreamDelta(
        makeStreamDelta("msg1", "https://example.com https://github.com/o/r/pull/1")
      );
      aggregator.handleStreamEnd(makeStreamEnd("msg1"));

      const links = aggregator.getDetectedLinks();
      expect(links).toHaveLength(2);
      expect(links[0].url).toBe("https://example.com");
      expect(links[1].url).toBe("https://github.com/o/r/pull/1");
    });

    it("extracts URLs split across deltas after compaction at stream-end", () => {
      aggregator.handleStreamStart(makeStreamStart("msg1"));
      // URL split across deltas - each partial won't match URL regex
      aggregator.handleStreamDelta(makeStreamDelta("msg1", "Check https://githu", 3));
      aggregator.handleStreamDelta(makeStreamDelta("msg1", "b.com/owner/repo/pu", 3));
      aggregator.handleStreamDelta(makeStreamDelta("msg1", "ll/123 please", 3));

      // Links not extracted yet (partials don't match)
      expect(aggregator.getDetectedLinks()).toHaveLength(0);

      // Stream-end triggers compaction which merges text, then rescans
      aggregator.handleStreamEnd(makeStreamEnd("msg1"));

      // Link should be detected from compacted text
      const links = aggregator.getDetectedLinks();
      expect(links).toHaveLength(1);
      expect(links[0].url).toBe("https://github.com/owner/repo/pull/123");
    });

    it("extracts URLs split across deltas before tool call after stream-end", () => {
      aggregator.handleStreamStart(makeStreamStart("msg1"));
      // URL split across deltas before tool call
      aggregator.handleStreamDelta(makeStreamDelta("msg1", "See https://github", 3));
      aggregator.handleStreamDelta(makeStreamDelta("msg1", ".com/o/r/pull/99 ", 3));

      // Tool call starts - assistant text is still streaming (links extracted on stream-end)
      aggregator.handleToolCallStart(makeToolCallStart("msg1", "tool1"));

      // Stream-end should still catch it after compaction
      aggregator.handleStreamEnd(makeStreamEnd("msg1"));

      // Link should be detected after stream-end compaction
      const links = aggregator.getDetectedLinks();
      expect(links).toHaveLength(1);
      expect(links[0].url).toBe("https://github.com/o/r/pull/99");
    });

    it("extracts multiple links in order", () => {
      aggregator.handleStreamStart(makeStreamStart("msg1"));
      aggregator.handleStreamDelta(makeStreamDelta("msg1", "First: https://github.com/o/r/pull/1"));
      aggregator.handleStreamDelta(
        makeStreamDelta("msg1", " Second: https://github.com/o/r/pull/2")
      );
      aggregator.handleStreamEnd(makeStreamEnd("msg1"));

      // Both links should be detected in order
      const links = aggregator.getDetectedLinks();
      expect(links).toHaveLength(2);
      expect(links.map((l) => l.url)).toEqual([
        "https://github.com/o/r/pull/1",
        "https://github.com/o/r/pull/2",
      ]);
    });
  });

  describe("clear()", () => {
    it("clears links along with messages", () => {
      aggregator.handleStreamStart(makeStreamStart("msg1"));
      aggregator.handleStreamDelta(makeStreamDelta("msg1", "https://example.com"));
      aggregator.handleStreamEnd(makeStreamEnd("msg1"));

      aggregator.clear();

      expect(aggregator.getDetectedLinks()).toEqual([]);
    });
  });
});
