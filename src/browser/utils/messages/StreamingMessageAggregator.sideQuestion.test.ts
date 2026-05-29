import { describe, it, expect } from "bun:test";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

const WORKSPACE_CREATED_AT = "2026-05-01T00:00:00.000Z";

/**
 * Append a normal main-agent assistant message via the same code path the
 * live system uses: a `type: "message"` envelope routed through
 * `handleMessage`. We deliberately do NOT poke private state — the test
 * must exercise the same `muxMetadata` round-trip as a real chat event.
 */
function appendMainAssistant(
  aggregator: StreamingMessageAggregator,
  id: string,
  historySequence: number,
  text = ""
): void {
  const envelope: WorkspaceChatMessage = {
    type: "message",
    id,
    role: "assistant",
    parts: text ? [{ type: "text", text }] : [],
    metadata: { historySequence, timestamp: historySequence, model: "claude-sonnet-4" },
  };
  aggregator.handleMessage(envelope);
}

/**
 * Append a /btw user question with the interruption snapshot the backend
 * stamps onto its muxMetadata. The renderer uses these fields to split
 * the interrupted main-agent message visually.
 */
function appendSideUser(
  aggregator: StreamingMessageAggregator,
  id: string,
  historySequence: number,
  question: string,
  interruption?: {
    interruptedMessageId: string;
    interruptedTextLength: number;
    interruptedPartIndex?: number;
    interruptedHistorySequence?: number;
  }
): void {
  const envelope: WorkspaceChatMessage = {
    type: "message",
    id,
    role: "user",
    parts: [{ type: "text", text: question }],
    metadata: {
      historySequence,
      timestamp: historySequence,
      muxMetadata: {
        type: "side-question",
        rawCommand: `/btw ${question}`,
        commandPrefix: "/btw",
        ...interruption,
      },
    },
  };
  aggregator.handleMessage(envelope);
}

/**
 * Append a /btw assistant placeholder/final. The side-question pipeline
 * persists this row first (so stream-start has a real historySequence to
 * attach to), then emits stream-start against the same messageId.
 */
function appendSideAnswer(
  aggregator: StreamingMessageAggregator,
  id: string,
  historySequence: number,
  text = "",
  questionMessageId?: string
): void {
  const envelope: WorkspaceChatMessage = {
    type: "message",
    id,
    role: "assistant",
    parts: text ? [{ type: "text", text }] : [],
    metadata: {
      historySequence,
      timestamp: historySequence,
      model: "claude-haiku-3.5",
      muxMetadata: {
        type: "side-question-answer",
        ...(questionMessageId ? { questionMessageId } : {}),
      },
    },
  };
  aggregator.handleMessage(envelope);
}

function readSideQuestionPlacement(
  row: ReturnType<StreamingMessageAggregator["getDisplayedMessages"]>[number]
): "interrupted" | "standalone" | undefined {
  return row.type === "user" || row.type === "assistant"
    ? row.sideQuestionBranch?.placement
    : undefined;
}

describe("StreamingMessageAggregator /btw rendering", () => {
  it("marks side-question-answer rows with isSideAnswer in displayed messages", () => {
    // Regression: the renderer derives `isSideAnswer` from the
    // assistant message's muxMetadata. If muxMetadata is lost (e.g.,
    // dropped across stream-start), the badge and split-rendering both
    // break. We assert the displayed-row marker rather than poking
    // private predicates.
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    appendMainAssistant(aggregator, "main-1", 1, "hello");
    appendSideAnswer(aggregator, "side-1", 2, "two");

    const rows = aggregator.getDisplayedMessages();
    const mainRow = rows.find((r) => r.type === "assistant" && r.historyId === "main-1");
    const sideRow = rows.find((r) => r.type === "assistant" && r.historyId === "side-1");
    expect(mainRow && "isSideAnswer" in mainRow ? mainRow.isSideAnswer : undefined).toBeFalsy();
    expect(sideRow && "isSideAnswer" in sideRow ? sideRow.isSideAnswer : undefined).toBe(true);
  });

  it("carries side-question-answer muxMetadata across stream-start", () => {
    // Regression coverage: stream-start replaces the existing message
    // with a fresh envelope built from the event payload. The
    // side-question pipeline emits the placeholder `message` event
    // (with muxMetadata) BEFORE stream-start so the marker is in the
    // aggregator first; the carry-forward logic in handleStreamStart
    // then preserves it across the fresh envelope. Without that
    // carry-forward, the displayed row loses isSideAnswer and the
    // "side answer" header + split rendering both break.
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    appendSideAnswer(aggregator, "side-1", 1);

    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "ws",
      messageId: "side-1",
      model: "claude-haiku-3.5",
      historySequence: 1,
      startTime: 1_000,
    });

    aggregator.handleStreamDelta({
      type: "stream-delta",
      workspaceId: "ws",
      messageId: "side-1",
      delta: "two",
      tokens: 1,
      timestamp: 1_100,
    });

    const rows = aggregator.getDisplayedMessages();
    const sideRow = rows.find((r) => r.type === "assistant" && r.historyId === "side-1");
    expect(sideRow && "isSideAnswer" in sideRow ? sideRow.isSideAnswer : undefined).toBe(true);
  });

  it("does not let side-answer models replace the workspace current model", () => {
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    appendMainAssistant(aggregator, "main-1", 1, "main answer");
    appendSideAnswer(aggregator, "btw-a", 2, "side answer");
    expect(aggregator.getCurrentModel()).toBe("claude-sonnet-4");

    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "ws",
      messageId: "btw-a",
      model: "claude-haiku-3.5",
      historySequence: 2,
      startTime: 1_000,
    });
    expect(aggregator.getCurrentModel()).toBe("claude-sonnet-4");
  });

  it("returns the main-agent active stream when a side answer started first", () => {
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    appendSideAnswer(aggregator, "btw-a", 1, "side answer");
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "ws",
      messageId: "btw-a",
      model: "claude-haiku-3.5",
      historySequence: 1,
      startTime: 1_000,
    });

    appendMainAssistant(aggregator, "main-1", 2, "main answer");
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "ws",
      messageId: "main-1",
      model: "claude-sonnet-4",
      historySequence: 2,
      startTime: 1_100,
    });

    expect(aggregator.getActiveStreamMessageId()).toBe("main-1");
    expect(aggregator.getActiveStreamTimingStats()?.model).toBe("claude-sonnet-4");

    aggregator.setInterrupting();
    expect(aggregator.isInterrupting("main-1")).toBe(true);
    expect(aggregator.isInterrupting("btw-a")).toBe(false);
  });

  it("treats main-agent completion as final while a side answer is still streaming", () => {
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT, "ws");
    const completions: Array<{
      messageId: string | undefined;
      isFinal: boolean;
      completedAt: number | null | undefined;
    }> = [];
    aggregator.onResponseComplete = (event) => {
      completions.push({
        messageId: event.messageId,
        isFinal: event.isFinal,
        completedAt: event.completedAt,
      });
    };

    appendSideAnswer(aggregator, "btw-a", 1);
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "ws",
      messageId: "btw-a",
      model: "claude-haiku-3.5",
      historySequence: 1,
      startTime: 1_000,
    });

    appendMainAssistant(aggregator, "main-1", 2);
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "ws",
      messageId: "main-1",
      model: "claude-sonnet-4",
      historySequence: 2,
      startTime: 1_100,
    });
    aggregator.handleStreamDelta({
      type: "stream-delta",
      workspaceId: "ws",
      messageId: "main-1",
      delta: "main done",
      tokens: 2,
      timestamp: 1_200,
    });
    aggregator.handleStreamEnd({
      type: "stream-end",
      workspaceId: "ws",
      messageId: "main-1",
      parts: [{ type: "text", text: "main done" }],
      metadata: { model: "claude-sonnet-4", duration: 200, historySequence: 2 },
    });

    expect(completions).toHaveLength(1);
    expect(completions[0]?.messageId).toBe("main-1");
    expect(completions[0]?.isFinal).toBe(true);
    expect(completions[0]?.completedAt).not.toBeNull();

    aggregator.handleStreamEnd({
      type: "stream-end",
      workspaceId: "ws",
      messageId: "btw-a",
      parts: [{ type: "text", text: "side done" }],
      metadata: { model: "claude-haiku-3.5", duration: 300, historySequence: 1 },
    });
    expect(completions).toHaveLength(1);
  });

  it("keeps queued follow-up suppression when a side answer starts", () => {
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT, "ws");
    const completions: Array<{ hasAutoFollowUp: boolean | undefined }> = [];
    aggregator.onResponseComplete = (event) => {
      completions.push({
        hasAutoFollowUp:
          event.completion?.kind === "response" ? event.completion.hasAutoFollowUp : undefined,
      });
    };

    appendMainAssistant(aggregator, "main-1", 1);
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "ws",
      messageId: "main-1",
      model: "claude-sonnet-4",
      historySequence: 1,
      startTime: 1_000,
    });
    aggregator.setActiveQueuedFollowUp(true);

    appendSideAnswer(aggregator, "btw-a", 2);
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "ws",
      messageId: "btw-a",
      model: "claude-haiku-3.5",
      historySequence: 2,
      startTime: 1_100,
    });

    aggregator.handleStreamDelta({
      type: "stream-delta",
      workspaceId: "ws",
      messageId: "main-1",
      delta: "main done",
      tokens: 2,
      timestamp: 1_200,
    });
    aggregator.handleStreamEnd({
      type: "stream-end",
      workspaceId: "ws",
      messageId: "main-1",
      parts: [{ type: "text", text: "main done" }],
      metadata: { model: "claude-sonnet-4", duration: 200, historySequence: 1 },
    });

    expect(completions).toEqual([{ hasAutoFollowUp: true }]);
  });

  it("places the /btw question at the interruption point before the answer row exists", () => {
    // The side-answer placeholder is emitted after the user row, so the user
    // question itself must own the interruption anchor. Otherwise the question
    // can sit at the live tail until model setup finishes and the first answer
    // token arrives.
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    appendMainAssistant(aggregator, "main-1", 1, "hello world");
    appendSideUser(aggregator, "btw-q", 2, "what's 2+2", {
      interruptedMessageId: "main-1",
      interruptedTextLength: 5,
      interruptedHistorySequence: 1,
    });

    const visibleHistoryIds = aggregator
      .getDisplayedMessages()
      .filter((r) => r.type === "assistant" || r.type === "user")
      .map((r) => r.historyId);

    expect(visibleHistoryIds).toEqual(["main-1", "btw-q", "main-1"]);
  });

  it("places /btw at the interruption point while the side answer streams", () => {
    // The side branch should not stay pinned to the transcript tail for the
    // entire side-answer stream. As soon as the side answer exists, split the
    // interrupted main-agent message so subsequent main text appears below the
    // /btw pair.
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    appendMainAssistant(aggregator, "main-1", 1, "hello world");
    appendSideUser(aggregator, "btw-q", 2, "what's 2+2", {
      interruptedMessageId: "main-1",
      interruptedTextLength: 5,
      interruptedHistorySequence: 1,
    });
    appendSideAnswer(aggregator, "btw-a", 3);

    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "ws",
      messageId: "btw-a",
      model: "claude-haiku-3.5",
      historySequence: 3,
      startTime: 1_000,
    });
    aggregator.handleStreamDelta({
      type: "stream-delta",
      workspaceId: "ws",
      messageId: "btw-a",
      delta: "four",
      tokens: 1,
      timestamp: 1_100,
    });

    const readVisibleHistoryIds = (): string[] =>
      aggregator
        .getDisplayedMessages()
        .filter((r) => r.type === "assistant" || r.type === "user")
        .map((r) => r.historyId);

    // Still streaming: the side branch is already inserted at the captured
    // interruption point instead of sticking to the transcript tail.
    expect(readVisibleHistoryIds()).toEqual(["main-1", "btw-q", "btw-a", "main-1"]);

    aggregator.handleStreamEnd({
      type: "stream-end",
      workspaceId: "ws",
      messageId: "btw-a",
      parts: [{ type: "text", text: "four" }],
      metadata: {
        model: "claude-haiku-3.5",
        timestamp: 1_200,
        duration: 200,
        historySequence: 3,
      },
    });

    // Settling preserves the same split order.
    expect(readVisibleHistoryIds()).toEqual(["main-1", "btw-q", "btw-a", "main-1"]);
  });

  it("does not reset main-agent lifecycle when a /btw user row arrives", () => {
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    aggregator.handleStreamLifecycle({
      type: "stream-lifecycle",
      workspaceId: "ws",
      phase: "streaming",
      hadAnyOutput: true,
    });
    appendSideUser(aggregator, "btw-q", 2, "what is this?", {
      interruptedMessageId: "main-1",
      interruptedTextLength: 5,
    });

    expect(aggregator.getStreamLifecycle()?.phase).toBe("streaming");
    expect(aggregator.getPendingStreamStartTime()).toBeNull();
  });

  it("preserves pending main-agent startup when a side answer starts first", () => {
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    aggregator.handleMessage({
      type: "message",
      id: "main-user",
      role: "user",
      parts: [{ type: "text", text: "do the main work" }],
      metadata: {
        historySequence: 1,
        timestamp: 1,
        muxMetadata: { type: "normal", requestedModel: "claude-sonnet-4" },
      },
    });
    aggregator.handleRuntimeStatus({
      type: "runtime-status",
      workspaceId: "ws",
      phase: "starting",
      runtimeType: "local",
      detail: "Starting main turn...",
    });
    const pendingStart = aggregator.getPendingStreamStartTime();
    expect(pendingStart).not.toBeNull();

    appendSideAnswer(aggregator, "btw-a", 2);
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "ws",
      messageId: "btw-a",
      model: "claude-haiku-3.5",
      historySequence: 2,
      startTime: 1_000,
    });

    expect(aggregator.getPendingStreamStartTime()).toBe(pendingStart);
    expect(aggregator.getRuntimeStatus()?.phase).toBe("starting");

    aggregator.handleStreamEnd({
      type: "stream-end",
      workspaceId: "ws",
      messageId: "btw-a",
      parts: [{ type: "text", text: "side answer" }],
      metadata: { model: "claude-haiku-3.5", duration: 200, historySequence: 2 },
    });

    expect(aggregator.getPendingStreamStartTime()).toBe(pendingStart);
    expect(aggregator.getRuntimeStatus()?.phase).toBe("starting");
  });

  it("splits the interrupted main-agent message around the /btw pair", () => {
    // Visual ordering contract: the side branch must appear BETWEEN the
    // pre-aside and post-aside halves of the main agent's reply, not
    // below the entire reply. We assert the order of historyIds in the
    // displayed-message stream: main-1 (pre), side user, side answer,
    // main-1 (post). Both main-1 halves use the same historyId so
    // action handlers still resolve to the persisted message.
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    // Main agent has produced "hello world" (11 chars) before /btw fired
    // at text length 5 ("hello").
    appendMainAssistant(aggregator, "main-1", 1, "hello world");
    appendSideUser(aggregator, "btw-q", 2, "what's 2+2", {
      interruptedMessageId: "main-1",
      interruptedTextLength: 5,
      interruptedHistorySequence: 1,
    });
    appendSideAnswer(aggregator, "btw-a", 3, "four", "btw-q");

    const rows = aggregator.getDisplayedMessages();
    const visibleHistoryIds = rows
      .filter((r) => r.type === "assistant" || r.type === "user")
      .map((r) => r.historyId);

    // Pre-aside main row, side question, side answer, post-aside main row.
    expect(visibleHistoryIds).toEqual(["main-1", "btw-q", "btw-a", "main-1"]);

    const sideRows = rows.filter(
      (r) =>
        (r.type === "user" || r.type === "assistant") &&
        (r.historyId === "btw-q" || r.historyId === "btw-a")
    );
    expect(sideRows).toHaveLength(2);
    for (const row of sideRows) {
      if (row.type !== "user" && row.type !== "assistant") {
        throw new Error("expected /btw display rows to be user or assistant rows");
      }
      expect(row.sideQuestionBranch).toEqual({
        branchId: "btw-q",
        placement: "interrupted",
        interruptedMessageId: "main-1",
        interruptedHistorySequence: 1,
      });
    }

    // The pre and post halves carry the split text content.
    const mainRows = rows.filter(
      (r): r is Extract<typeof r, { type: "assistant"; content: string }> =>
        r.type === "assistant" && r.historyId === "main-1"
    );
    expect(mainRows).toHaveLength(2);
    expect(mainRows[0].content).toBe("hello");
    expect(mainRows[1].content).toBe(" world");
  });

  it("pairs concurrent /btw answers by question id instead of adjacency", () => {
    // Two side questions can be persisted before either answer placeholder is
    // appended. The answer metadata links back to its question so delayed
    // placeholders do not get paired with whichever /btw row happens to sit
    // immediately above them in history order.
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    appendMainAssistant(aggregator, "main-1", 1, "alpha beta gamma");
    appendSideUser(aggregator, "btw-q1", 2, "earlier", {
      interruptedMessageId: "main-1",
      interruptedTextLength: 5,
    });
    appendSideUser(aggregator, "btw-q2", 3, "later", {
      interruptedMessageId: "main-1",
      interruptedTextLength: 10,
    });
    appendSideAnswer(aggregator, "btw-a1", 4, "answer-1", "btw-q1");
    appendSideAnswer(aggregator, "btw-a2", 5, "answer-2", "btw-q2");

    const rows = aggregator.getDisplayedMessages();
    const visibleHistoryIds = rows
      .filter((r) => r.type === "assistant" || r.type === "user")
      .map((r) => r.historyId);

    expect(visibleHistoryIds).toEqual([
      "main-1",
      "btw-q1",
      "btw-a1",
      "main-1",
      "btw-q2",
      "btw-a2",
      "main-1",
    ]);
  });

  it("does not duplicate anchored /btw rows when side rows sort before the interrupted assistant", () => {
    // The split owner must be decided before the display walk starts. Otherwise
    // out-of-order replay can render the side rows chronologically and then
    // render them again inside the interrupted assistant split.
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    appendSideUser(aggregator, "btw-q", 2, "what's 2+2", {
      interruptedMessageId: "main-1",
      interruptedTextLength: 5,
      interruptedHistorySequence: 10,
    });
    appendSideAnswer(aggregator, "btw-a", 3, "four", "btw-q");
    appendMainAssistant(aggregator, "main-1", 10, "hello world");

    const visibleHistoryIds = aggregator
      .getDisplayedMessages()
      .filter((r) => r.type === "assistant" || r.type === "user")
      .map((r) => r.historyId);

    expect(visibleHistoryIds).toEqual(["main-1", "btw-q", "btw-a", "main-1"]);
    expect(visibleHistoryIds.filter((id) => id === "btw-q")).toHaveLength(1);
    expect(visibleHistoryIds.filter((id) => id === "btw-a")).toHaveLength(1);
  });

  it("treats interruptedHistorySequence mismatches as standalone /btw rows", () => {
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    appendMainAssistant(aggregator, "main-1", 1, "hello world");
    appendSideUser(aggregator, "btw-q", 2, "stale anchor", {
      interruptedMessageId: "main-1",
      interruptedTextLength: 5,
      interruptedHistorySequence: 999,
    });
    appendSideAnswer(aggregator, "btw-a", 3, "answer", "btw-q");

    const rows = aggregator.getDisplayedMessages();
    const visibleHistoryIds = rows
      .filter((r) => r.type === "assistant" || r.type === "user")
      .map((r) => r.historyId);

    expect(visibleHistoryIds).toEqual(["main-1", "btw-q", "btw-a"]);
    const sideRows = rows.filter(
      (r) =>
        (r.type === "user" || r.type === "assistant") &&
        (r.historyId === "btw-q" || r.historyId === "btw-a")
    );
    expect(sideRows.map(readSideQuestionPlacement)).toEqual(["standalone", "standalone"]);
  });

  it("keeps /btw rows chronological when the interrupted assistant owner is hidden", () => {
    // Synthetic assistant messages are hidden from the transcript. If a stale
    // /btw anchor points at one, the side rows must remain visible instead of
    // being reserved for a split owner that will never render.
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    aggregator.handleMessage({
      type: "message",
      id: "main-hidden",
      role: "assistant",
      parts: [{ type: "text", text: "hidden main output" }],
      metadata: { historySequence: 1, timestamp: 1, synthetic: true },
    });
    appendSideUser(aggregator, "btw-q", 2, "why hidden?", {
      interruptedMessageId: "main-hidden",
      interruptedTextLength: 6,
      interruptedHistorySequence: 1,
    });
    appendSideAnswer(aggregator, "btw-a", 3, "because synthetic", "btw-q");

    const rows = aggregator.getDisplayedMessages();
    const visibleHistoryIds = rows
      .filter((r) => r.type === "assistant" || r.type === "user")
      .map((r) => r.historyId);

    expect(visibleHistoryIds).toEqual(["btw-q", "btw-a"]);
    expect(rows.map(readSideQuestionPlacement)).toEqual(["standalone", "standalone"]);
  });

  it("keeps pre-existing non-text parts before the side branch at the same text offset", () => {
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    aggregator.handleMessage({
      type: "message",
      id: "main-1",
      role: "assistant",
      parts: [
        { type: "text", text: "hello" },
        { type: "reasoning", text: "thinking that was already visible" },
        { type: "text", text: " world" },
      ],
      metadata: { historySequence: 1, timestamp: 1, model: "claude-sonnet-4" },
    });
    appendSideUser(aggregator, "btw-q", 2, "question after reasoning", {
      interruptedMessageId: "main-1",
      interruptedTextLength: 5,
      interruptedPartIndex: 2,
      interruptedHistorySequence: 1,
    });
    appendSideAnswer(aggregator, "btw-a", 3, "side answer");

    const visibleRows = aggregator
      .getDisplayedMessages()
      .filter((row) => row.type === "reasoning" || row.type === "assistant" || row.type === "user")
      .map((row) => `${row.type}:${row.historyId}`);

    expect(visibleRows).toEqual([
      "assistant:main-1",
      "reasoning:main-1",
      "user:btw-q",
      "assistant:btw-a",
      "assistant:main-1",
    ]);
  });

  it("puts reasoning emitted after a zero-offset /btw below the side branch", () => {
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    aggregator.handleMessage({
      type: "message",
      id: "main-1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "thinking after the aside" },
        { type: "text", text: "answer after the aside" },
      ],
      metadata: { historySequence: 1, timestamp: 1, model: "claude-sonnet-4" },
    });
    appendSideUser(aggregator, "btw-q", 2, "question before output", {
      interruptedMessageId: "main-1",
      interruptedTextLength: 0,
      interruptedHistorySequence: 1,
    });
    appendSideAnswer(aggregator, "btw-a", 3, "side answer");

    const visibleRows = aggregator
      .getDisplayedMessages()
      .filter((row) => row.type === "reasoning" || row.type === "assistant" || row.type === "user")
      .map((row) => `${row.type}:${row.historyId}`);

    expect(visibleRows).toEqual([
      "user:btw-q",
      "assistant:btw-a",
      "reasoning:main-1",
      "assistant:main-1",
    ]);
  });

  it("interleaves multiple /btw pairs in sorted text-length order", () => {
    // Two /btw fired during the same main-agent turn. The renderer
    // must order them by their captured interruptedTextLength so the
    // earlier one sits above the later one (matching the order they
    // were fired in real time).
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    appendMainAssistant(aggregator, "main-1", 1, "alpha beta gamma");
    // Second /btw was fired earlier (lower text length anchor) but
    // arrived after the first in iteration order — splitting must sort
    // by `interruptedTextLength`, not insertion order, to render them
    // where they actually belong in the main agent's stream.
    appendSideUser(aggregator, "btw-q2", 2, "later", {
      interruptedMessageId: "main-1",
      interruptedTextLength: 10, // After "alpha beta"
    });
    appendSideAnswer(aggregator, "btw-a2", 3, "answer-2");
    appendSideUser(aggregator, "btw-q1", 4, "earlier", {
      interruptedMessageId: "main-1",
      interruptedTextLength: 5, // After "alpha"
    });
    appendSideAnswer(aggregator, "btw-a1", 5, "answer-1");

    const rows = aggregator.getDisplayedMessages();
    const visibleHistoryIds = rows
      .filter((r) => r.type === "assistant" || r.type === "user")
      .map((r) => r.historyId);

    // Earlier interrupt (text length 5) renders first, later one second.
    expect(visibleHistoryIds).toEqual([
      "main-1",
      "btw-q1",
      "btw-a1",
      "main-1",
      "btw-q2",
      "btw-a2",
      "main-1",
    ]);

    const mainRows = rows.filter(
      (r): r is Extract<typeof r, { type: "assistant"; content: string }> =>
        r.type === "assistant" && r.historyId === "main-1"
    );
    expect(mainRows.map((r) => r.content)).toEqual(["alpha", " beta", " gamma"]);
  });

  it("places /btw at the start when fired before any main-agent text", () => {
    // Edge case: /btw fires immediately after stream-start, before any
    // text deltas arrive. interruptedTextLength is 0, so the pre-aside
    // half is empty. The side branch should still render above the
    // main agent's content rather than below it.
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    appendMainAssistant(aggregator, "main-1", 1, "all the text");
    appendSideUser(aggregator, "btw-q", 2, "quick", {
      interruptedMessageId: "main-1",
      interruptedTextLength: 0,
    });
    appendSideAnswer(aggregator, "btw-a", 3, "answer");

    const rows = aggregator.getDisplayedMessages();
    const visibleHistoryIds = rows
      .filter((r) => r.type === "assistant" || r.type === "user")
      .map((r) => r.historyId);

    // Empty pre-aside is omitted (no parts -> no row). Side branch
    // renders, then the entire main-agent reply.
    expect(visibleHistoryIds).toEqual(["btw-q", "btw-a", "main-1"]);
  });

  it("falls back to a normal end-of-transcript render when no main-agent stream was in flight", () => {
    // Without interruptedMessageId, the /btw user message has no anchor
    // to split against — it should render at the end of the transcript
    // in sequence order. (This is what happens when /btw is fired
    // between turns rather than during a stream.)
    const aggregator = new StreamingMessageAggregator(WORKSPACE_CREATED_AT);

    appendMainAssistant(aggregator, "main-1", 1, "done.");
    appendSideUser(aggregator, "btw-q", 2, "follow-up"); // no interruption fields
    appendSideAnswer(aggregator, "btw-a", 3, "follow-up answer");

    const rows = aggregator.getDisplayedMessages();
    const visibleHistoryIds = rows
      .filter((r) => r.type === "assistant" || r.type === "user")
      .map((r) => r.historyId);

    expect(visibleHistoryIds).toEqual(["main-1", "btw-q", "btw-a"]);

    const sideRows = rows.filter(
      (r) =>
        (r.type === "user" || r.type === "assistant") &&
        (r.historyId === "btw-q" || r.historyId === "btw-a")
    );
    expect(sideRows.map(readSideQuestionPlacement)).toEqual(["standalone", "standalone"]);
  });
});
