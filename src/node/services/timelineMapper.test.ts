import { describe, expect, test } from "bun:test";
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas/stream";
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

  test("clears stream and tool state after a terminal stream error", () => {
    const started = map({
      type: "stream-start",
      workspaceId: "ws-1",
      messageId: "assistant-failed",
      model: "claude-sonnet-4",
      historySequence: 12,
      startTime: 200,
    });
    const toolStarted = map(
      {
        type: "tool-call-start",
        workspaceId: "ws-1",
        messageId: "assistant-failed",
        toolCallId: "tool-failed",
        toolName: "bash",
        args: { script: "git status" },
        tokens: 1,
        timestamp: 210,
      },
      started.state
    );
    const failed = map(
      {
        type: "stream-error",
        workspaceId: "ws-1",
        messageId: "assistant-failed",
        error: "provider failed",
        errorType: "api",
      },
      toolStarted.state
    );

    expect(failed.state.openStreams.size).toBe(0);
    expect(failed.state.openToolCalls.size).toBe(0);
  });

  test("maps notable tool completion and drops routine reads", () => {
    const started = map({
      type: "tool-call-start",
      workspaceId: "ws-1",
      messageId: "assistant-1",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { script: "git status" },
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
        result: { success: true },
        timestamp: 350,
      },
      started.state
    );
    const readStarted = map({
      type: "tool-call-start",
      workspaceId: "ws-1",
      messageId: "assistant-1",
      toolCallId: "tool-2",
      toolName: "bash",
      args: { script: "ls" },
      tokens: 1,
      timestamp: 360,
    });
    const readCompleted = map(
      {
        type: "tool-call-end",
        workspaceId: "ws-1",
        messageId: "assistant-1",
        toolCallId: "tool-2",
        toolName: "bash",
        result: { success: true },
        timestamp: 370,
      },
      readStarted.state
    );

    expect(completed.drafts).toHaveLength(1);
    expect(completed.drafts[0]).toMatchObject({
      kind: "tool.call",
      status: "completed",
      data: { toolName: "bash", durationMs: 40, digest: "git status" },
    });
    expect(completed.state.openToolCalls.size).toBe(0);
    expect(readCompleted.drafts).toEqual([]);
  });

  test("synthesizes interrupted rows for notable open tools on stream abort", () => {
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

    expect(aborted.drafts).toHaveLength(2);
    expect(aborted.drafts[0]).toMatchObject({
      kind: "turn.interrupted",
      status: "interrupted",
    });
    expect(aborted.drafts[1]).toMatchObject({
      kind: "tool.call",
      status: "interrupted",
      anchor: { toolCallId: "tool-1" },
      data: { toolName: "file_edit_insert", digest: "src/app.ts" },
    });
    expect(aborted.state.openToolCalls.size).toBe(0);
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
      anchor: { toolCallId: "tool-task", taskId: "task-1" },
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
