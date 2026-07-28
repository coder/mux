import { describe, expect, test } from "bun:test";
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas/stream";
import { TimelineEventDraftSchema } from "@/common/orpc/schemas/timeline";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import {
  createTimelineMapperState,
  mapChatEventToTimeline,
  type TimelineMapperState,
} from "./timelineMapper";

const RECEIVED_AT = 1_700_000_000_500;

function event(value: unknown): WorkspaceChatMessage {
  return WorkspaceChatMessageSchema.parse(value);
}

function map(value: unknown, state?: TimelineMapperState) {
  return mapChatEventToTimeline(event(value), state ?? createTimelineMapperState(), RECEIVED_AT);
}

describe("mapChatEventToTimeline", () => {
  test("discriminates compaction and reset boundary messages", () => {
    const compaction = map({
      type: "message",
      id: "compact-1",
      role: "assistant",
      parts: [{ type: "text", text: "summary" }],
      metadata: {
        historySequence: 10,
        timestamp: 100,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 2,
      },
    });
    const reset = map({
      type: "message",
      id: "reset-1",
      role: "assistant",
      parts: [],
      metadata: { historySequence: 11, timestamp: 101, contextBoundaryKind: "reset" },
    });

    expect(compaction.drafts).toHaveLength(1);
    expect(compaction.drafts[0]).toMatchObject({ kind: "compaction.completed", epoch: 2, ts: 100 });
    expect(reset.drafts).toHaveLength(1);
    expect(reset.drafts[0]).toMatchObject({ kind: "context.reset", ts: 101 });
  });

  test("maps stream completion and failure lifecycle events", () => {
    const started = map({
      type: "stream-start",
      workspaceId: "ws-1",
      messageId: "assistant-1",
      model: "claude-sonnet-4",
      historySequence: 12,
      startTime: 200,
      mode: "exec",
    });
    const completed = map(
      {
        type: "stream-end",
        workspaceId: "ws-1",
        messageId: "assistant-1",
        metadata: { model: "claude-sonnet-4", duration: 75, timestamp: 275 },
        parts: [],
      },
      started.state
    );
    const failed = map({
      type: "error",
      workspaceId: "ws-1",
      messageId: "assistant-2",
      error: "provider failed",
      errorType: "api",
    });

    expect(started.drafts).toEqual([]);
    expect(completed.drafts).toHaveLength(1);
    expect(completed.drafts[0]).toMatchObject({
      kind: "turn.completed",
      status: "completed",
      ts: 275,
      anchor: { historySequence: 12, messageId: "assistant-1" },
      data: { model: "claude-sonnet-4", durationMs: 75 },
    });
    expect(failed.drafts).toHaveLength(1);
    expect(failed.drafts[0]).toMatchObject({
      kind: "turn.failed",
      status: "failed",
      data: { reason: "provider failed", errorKind: "api" },
    });
  });

  test("clears stream state after a terminal stream error", () => {
    const started = map({
      type: "stream-start",
      workspaceId: "ws-1",
      messageId: "assistant-failed",
      model: "claude-sonnet-4",
      historySequence: 12,
      startTime: 200,
    });
    const failed = map(
      {
        type: "stream-error",
        workspaceId: "ws-1",
        messageId: "assistant-failed",
        error: "provider failed",
        errorType: "api",
      },
      started.state
    );

    expect(failed.state.openStreams.size).toBe(0);
  });

  test("ignores tool call lifecycle events", () => {
    const started = map({
      type: "tool-call-start",
      workspaceId: "ws-1",
      messageId: "assistant-1",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { script: "git commit -m x" },
      tokens: 3,
      timestamp: 300,
      executionStartedAt: 310,
    });
    const completed = map(
      {
        type: "tool-call-end",
        workspaceId: "ws-1",
        messageId: "assistant-1",
        toolCallId: "tool-1",
        toolName: "bash",
        result: { success: false, error: "boom" },
        timestamp: 350,
      },
      started.state
    );

    expect(started.drafts).toEqual([]);
    expect(completed.drafts).toEqual([]);
  });

  test("emits a single turn row when a stream with open tool calls aborts", () => {
    const started = map({
      type: "tool-call-start",
      workspaceId: "ws-1",
      messageId: "assistant-1",
      toolCallId: "tool-1",
      toolName: "file_edit_insert",
      args: { path: "src/app.ts", content: "x" },
      tokens: 3,
      timestamp: 400,
    });
    const aborted = map(
      {
        type: "stream-abort",
        workspaceId: "ws-1",
        messageId: "assistant-1",
        abortReason: "user",
        metadata: { duration: 25 },
      },
      started.state
    );

    expect(aborted.drafts).toHaveLength(1);
    expect(aborted.drafts[0]).toMatchObject({
      kind: "turn.interrupted",
      status: "interrupted",
    });
  });

  test("records the first prompt in a workspace, which anchors at history sequence 0", () => {
    const first = map({
      type: "message",
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Create a small Python utility" }],
      metadata: { historySequence: 0, timestamp: 100 },
    });

    expect(first.drafts).toHaveLength(1);
    expect(first.drafts[0]).toMatchObject({
      kind: "turn.user",
      anchor: { historySequence: 0, messageId: "user-1" },
      data: { digest: "Create a small Python utility" },
    });
    expect(TimelineEventDraftSchema.safeParse(first.drafts[0]).success).toBe(true);
  });

  test("records one row per automatic compaction transition", () => {
    // Auto-compaction persists the request/boundary messages AND emits its own lifecycle events.
    const request = map({
      type: "message",
      id: "auto-compact-request",
      role: "user",
      parts: [{ type: "text", text: "Summarize this conversation for a new Assistant" }],
      metadata: {
        historySequence: 4,
        timestamp: 100,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      },
    });
    const triggered = map(
      { type: "auto-compaction-triggered", reason: "on-send", usagePercent: 92 },
      request.state
    );
    const boundary = map({
      type: "message",
      id: "auto-compact-boundary",
      role: "assistant",
      parts: [{ type: "text", text: "summary" }],
      metadata: {
        historySequence: 5,
        timestamp: 100,
        compacted: "idle",
        compactionBoundary: true,
        compactionEpoch: 3,
      },
    });
    const completed = map(
      { type: "auto-compaction-completed", newUsagePercent: 0 },
      boundary.state
    );

    expect(request.drafts.map((draft) => draft.kind)).toEqual(["compaction.triggered"]);
    expect(boundary.drafts.map((draft) => draft.kind)).toEqual(["compaction.completed"]);
    expect(triggered.drafts).toEqual([]);
    expect(completed.drafts).toEqual([]);
  });

  test("classifies a /compact request as compaction rather than a user prompt", () => {
    const compactRequest = map({
      type: "message",
      id: "user-compact",
      role: "user",
      parts: [{ type: "text", text: "Summarize this conversation for a new Assistant" }],
      metadata: {
        historySequence: 4,
        timestamp: 100,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      },
    });
    const heartbeatTurn = map({
      type: "message",
      id: "user-heartbeat",
      role: "user",
      parts: [{ type: "text", text: "Heartbeat check" }],
      metadata: {
        historySequence: 6,
        timestamp: 100,
        muxMetadata: { type: "heartbeat-request" },
      },
    });

    expect(compactRequest.drafts[0]).toMatchObject({
      kind: "compaction.triggered",
      status: "started",
    });
    expect(heartbeatTurn.drafts[0]).toMatchObject({ kind: "turn.synthetic" });
  });

  test("omits an empty message id instead of losing the row to validation", () => {
    const failed = map({
      type: "stream-error",
      workspaceId: "ws-1",
      messageId: "",
      error: "provider failed",
      errorType: "api",
    });

    expect(failed.drafts).toHaveLength(1);
    expect(failed.drafts[0].anchor).toEqual({});
    expect(TimelineEventDraftSchema.safeParse(failed.drafts[0]).success).toBe(true);

    expect(failed.drafts[0].source.key).toBeUndefined();
    const second = map({
      type: "stream-error",
      workspaceId: "ws-1",
      messageId: "",
      error: "provider failed again",
      errorType: "api",
    });
    expect(second.drafts[0].source.key).toBeUndefined();
  });

  test("records a history clear announced outside replaceHistory", () => {
    const cleared = map({
      type: "history-cleared",
      workspaceId: "ws-1",
      reason: "exec sub-agent hard restart",
    });

    expect(cleared.drafts).toMatchObject([
      { kind: "history.cleared", data: { reason: "exec sub-agent hard restart" } },
    ]);
  });

  test("leaves a child-caused budget limit to the goal service to avoid a duplicate row", () => {
    const base = {
      type: "goal-budget-limited" as const,
      workspaceId: "ws-1",
      goalId: "goal-1",
      message: "Child workspace exceeded the parent's goal budget.",
    };

    expect(map({ ...base, causedByChild: true, childWorkspaceId: "child-1" }).drafts).toHaveLength(
      0
    );
    expect(map({ ...base, causedByChild: false }).drafts).toMatchObject([
      { kind: "goal.budget_limited" },
    ]);
  });

  test("maps retry, task, workflow, and user turn events", () => {
    const retry = map({
      type: "auto-retry-scheduled",
      attempt: 2,
      delayMs: 1000,
      scheduledAt: 500,
    });
    expect(retry.drafts).toHaveLength(1);
    expect(retry.drafts[0]).toMatchObject({
      kind: "retry.scheduled",
      ts: 500,
      data: { attempt: 2, delayMs: 1000, scheduledAt: 500 },
    });

    const task = map({
      type: "task-created",
      workspaceId: "ws-1",
      toolCallId: "tool-task",
      taskId: "task-1",
      timestamp: 510,
    });
    expect(task.drafts).toHaveLength(1);
    expect(task.drafts[0]).toMatchObject({
      kind: "task.created",
      anchor: { toolCallId: "tool-task", taskId: "task-1", childWorkspaceId: "task-1" },
    });

    const workflow = map({
      type: "workflow-run-attached",
      workspaceId: "ws-1",
      messageId: "assistant-1",
      toolCallId: "tool-workflow",
      runId: "wfr_run_1",
      timestamp: 520,
    });
    expect(workflow.drafts).toHaveLength(1);
    expect(workflow.drafts[0]).toMatchObject({
      kind: "workflow.attached",
      data: { runId: "wfr_run_1" },
    });

    const user = map({
      type: "message",
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Do the work" }],
      metadata: { historySequence: 20, timestamp: 530 },
    });
    const synthetic = map({
      type: "message",
      id: "user-2",
      role: "user",
      parts: [{ type: "text", text: "Continue" }],
      metadata: { historySequence: 21, timestamp: 540, synthetic: true },
    });

    expect(user.drafts[0]?.kind).toBe("turn.user");
    expect(synthetic.drafts[0]?.kind).toBe("turn.synthetic");
  });
});
