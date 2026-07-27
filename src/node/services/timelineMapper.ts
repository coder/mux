import type { TimelineEventData, TimelineEventDraft } from "@/common/orpc/schemas/timeline";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { getContextBoundaryKind } from "@/common/utils/messages/compactionBoundary";
import { isFailedToolCallResult, isNotableToolCall } from "./timelineNotability";

interface OpenToolCall {
  workspaceId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  timestamp: number;
  executionStartedAt?: number;
}

interface OpenStream {
  workspaceId: string;
  messageId: string;
  historySequence: number;
  startTime: number;
  model: string;
  mode?: string;
  agentId?: string;
}

export interface TimelineMapperState {
  readonly openToolCalls: ReadonlyMap<string, OpenToolCall>;
  readonly openStreams: ReadonlyMap<string, OpenStream>;
}

export interface TimelineMapperResult {
  drafts: TimelineEventDraft[];
  state: TimelineMapperState;
}

export function createTimelineMapperState(): TimelineMapperState {
  return { openToolCalls: new Map(), openStreams: new Map() };
}

function eventKey(...parts: Array<string | number | undefined>): string {
  return parts.filter((part) => part != null).join(":");
}

function toolKey(workspaceId: string, toolCallId: string): string {
  return eventKey(workspaceId, toolCallId);
}

function streamKey(workspaceId: string, messageId: string): string {
  return eventKey(workspaceId, messageId);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: unknown, field: string): string | undefined {
  const fieldValue = asRecord(value)?.[field];
  return typeof fieldValue === "string" ? fieldValue : undefined;
}

function truncateDigest(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
}

function toolDigest(toolName: string, args: unknown): string | undefined {
  if (toolName === "bash") {
    const script = stringField(args, "script");
    return script != null && script.trim() !== "" ? truncateDigest(script) : undefined;
  }

  for (const field of ["path", "title", "label", "display_name"] as const) {
    const value = stringField(args, field);
    if (value != null && value.trim() !== "") {
      return truncateDigest(value);
    }
  }

  if (toolName === "memory") {
    return stringField(args, "command");
  }

  return undefined;
}

function messageTimestamp(
  event: Extract<WorkspaceChatMessage, { type: "message" }>,
  receivedAt: number
): number {
  return event.metadata?.timestamp ?? event.createdAt?.getTime() ?? receivedAt;
}

function messageAnchor(event: Extract<WorkspaceChatMessage, { type: "message" }>) {
  return {
    ...(event.metadata?.historySequence != null
      ? { historySequence: event.metadata.historySequence }
      : {}),
    messageId: event.id,
  };
}

function mapMessage(
  event: Extract<WorkspaceChatMessage, { type: "message" }>,
  receivedAt: number
): TimelineEventDraft[] {
  const ts = messageTimestamp(event, receivedAt);
  const anchor = messageAnchor(event);
  const epoch = event.metadata?.compactionEpoch;

  if (event.role === "user") {
    return [
      {
        ts,
        kind: event.metadata?.synthetic === true ? "turn.synthetic" : "turn.user",
        source: { system: "chat", key: eventKey("message", event.id) },
        anchor,
        ...(epoch != null ? { epoch } : {}),
      },
    ];
  }

  const boundaryKind = getContextBoundaryKind(event);
  if (boundaryKind === CONTEXT_BOUNDARY_KINDS.COMPACTION) {
    return [
      {
        ts,
        kind: "compaction.completed",
        source: { system: "chat", key: eventKey("boundary", event.id) },
        anchor,
        ...(epoch != null ? { epoch } : {}),
        status: "completed",
      },
    ];
  }

  if (boundaryKind === CONTEXT_BOUNDARY_KINDS.RESET) {
    return [
      {
        ts,
        kind: "context.reset",
        source: { system: "chat", key: eventKey("boundary", event.id) },
        anchor,
      },
    ];
  }

  return [];
}

function toolData(openTool: OpenToolCall | undefined, toolName: string, durationMs?: number) {
  const digest = toolDigest(toolName, openTool?.args);
  return {
    toolName,
    ...(durationMs != null ? { durationMs } : {}),
    ...(digest != null ? { digest } : {}),
  };
}

function clearMessageState(
  state: TimelineMapperState,
  workspaceId: string,
  messageId: string
): TimelineMapperState {
  const openToolCalls = new Map(state.openToolCalls);
  for (const [key, tool] of openToolCalls) {
    if (tool.workspaceId === workspaceId && tool.messageId === messageId) {
      openToolCalls.delete(key);
    }
  }

  const openStreams = new Map(state.openStreams);
  openStreams.delete(streamKey(workspaceId, messageId));
  return { openToolCalls, openStreams };
}

export function mapChatEventToTimeline(
  event: WorkspaceChatMessage,
  state: TimelineMapperState,
  receivedAt: number
): TimelineMapperResult {
  if ("replay" in event && event.replay === true) {
    return { drafts: [], state };
  }

  switch (event.type) {
    case "message":
      return { drafts: mapMessage(event, receivedAt), state };

    case "stream-start": {
      const openStreams = new Map(state.openStreams);
      openStreams.set(streamKey(event.workspaceId, event.messageId), {
        workspaceId: event.workspaceId,
        messageId: event.messageId,
        historySequence: event.historySequence,
        startTime: event.startTime,
        model: event.model,
        ...(event.mode != null ? { mode: event.mode } : {}),
        ...(event.agentId != null ? { agentId: event.agentId } : {}),
      });
      return { drafts: [], state: { ...state, openStreams } };
    }

    case "stream-end": {
      const openStream = state.openStreams.get(streamKey(event.workspaceId, event.messageId));
      const data: TimelineEventData = {
        model: event.metadata.model,
        ...(event.metadata.mode != null ? { mode: event.metadata.mode } : {}),
        ...(event.metadata.agentId != null ? { agentId: event.metadata.agentId } : {}),
        ...(event.metadata.duration != null ? { durationMs: event.metadata.duration } : {}),
      };
      const draft: TimelineEventDraft = {
        ts: event.metadata.timestamp ?? receivedAt,
        kind: "turn.completed",
        source: { system: "chat", key: eventKey("stream-end", event.messageId) },
        anchor: {
          ...(openStream != null ? { historySequence: openStream.historySequence } : {}),
          messageId: event.messageId,
        },
        status: "completed",
        data,
      };
      return {
        drafts: [draft],
        state: clearMessageState(state, event.workspaceId, event.messageId),
      };
    }

    case "stream-abort": {
      const openStream = state.openStreams.get(streamKey(event.workspaceId, event.messageId));
      const drafts: TimelineEventDraft[] = [
        {
          ts: receivedAt,
          kind: "turn.interrupted",
          source: { system: "chat", key: eventKey("stream-abort", event.messageId) },
          anchor: {
            ...(openStream != null ? { historySequence: openStream.historySequence } : {}),
            messageId: event.messageId,
          },
          status: "interrupted",
          data: {
            ...(event.abortReason != null ? { reason: event.abortReason } : {}),
            ...(event.metadata?.duration != null ? { durationMs: event.metadata.duration } : {}),
          },
        },
      ];

      for (const openTool of state.openToolCalls.values()) {
        if (
          openTool.workspaceId !== event.workspaceId ||
          openTool.messageId !== event.messageId ||
          !isNotableToolCall(openTool.toolName, openTool.args, { success: true })
        ) {
          continue;
        }

        drafts.push({
          ts: receivedAt,
          kind: "tool.call",
          source: { system: "chat", key: eventKey("tool-interrupted", openTool.toolCallId) },
          anchor: {
            messageId: openTool.messageId,
            toolCallId: openTool.toolCallId,
          },
          status: "interrupted",
          data: toolData(openTool, openTool.toolName),
        });
      }

      return {
        drafts,
        state: clearMessageState(state, event.workspaceId, event.messageId),
      };
    }

    case "error":
    case "stream-error":
      return {
        drafts: [
          {
            ts: receivedAt,
            kind: "turn.failed",
            source: { system: "chat", key: eventKey(event.type, event.messageId) },
            anchor: { messageId: event.messageId },
            status: "failed",
            data: {
              reason: event.error,
              ...(event.errorType != null ? { errorKind: event.errorType } : {}),
            },
          },
        ],
        state,
      };

    case "tool-call-start": {
      const openToolCalls = new Map(state.openToolCalls);
      openToolCalls.set(toolKey(event.workspaceId, event.toolCallId), {
        workspaceId: event.workspaceId,
        messageId: event.messageId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        timestamp: event.timestamp,
        ...(event.executionStartedAt != null
          ? { executionStartedAt: event.executionStartedAt }
          : {}),
      });
      return { drafts: [], state: { ...state, openToolCalls } };
    }

    case "tool-call-execution-start": {
      const key = toolKey(event.workspaceId, event.toolCallId);
      const openTool = state.openToolCalls.get(key);
      if (openTool == null) {
        return { drafts: [], state };
      }
      const openToolCalls = new Map(state.openToolCalls);
      openToolCalls.set(key, { ...openTool, executionStartedAt: event.timestamp });
      return { drafts: [], state: { ...state, openToolCalls } };
    }

    case "tool-call-end": {
      const key = toolKey(event.workspaceId, event.toolCallId);
      const openTool = state.openToolCalls.get(key);
      const openToolCalls = new Map(state.openToolCalls);
      openToolCalls.delete(key);
      if (!isNotableToolCall(event.toolName, openTool?.args, event.result)) {
        return { drafts: [], state: { ...state, openToolCalls } };
      }

      const startedAt = openTool?.executionStartedAt ?? openTool?.timestamp;
      const durationMs = startedAt != null ? Math.max(0, event.timestamp - startedAt) : undefined;
      const failed = isFailedToolCallResult(event.result);
      return {
        drafts: [
          {
            ts: event.timestamp,
            kind: "tool.call",
            source: { system: "chat", key: eventKey("tool-end", event.toolCallId) },
            anchor: { messageId: event.messageId, toolCallId: event.toolCallId },
            status: failed ? "failed" : "completed",
            data: toolData(openTool, event.toolName, durationMs),
          },
        ],
        state: { ...state, openToolCalls },
      };
    }

    case "auto-compaction-triggered":
      return {
        drafts: [
          {
            ts: receivedAt,
            kind: "compaction.triggered",
            source: {
              system: "chat",
              key: eventKey("compaction-triggered", event.reason, receivedAt),
            },
            status: "started",
            data: { reason: event.reason, usagePercent: event.usagePercent },
          },
        ],
        state,
      };

    case "auto-compaction-completed":
      return {
        drafts: [
          {
            ts: receivedAt,
            kind: "compaction.completed",
            source: { system: "chat", key: eventKey("compaction-completed", receivedAt) },
            status: "completed",
            data: { newUsagePercent: event.newUsagePercent },
          },
        ],
        state,
      };

    case "auto-retry-scheduled":
      return {
        drafts: [
          {
            ts: event.scheduledAt,
            kind: "retry.scheduled",
            source: { system: "chat", key: eventKey("retry-scheduled", event.scheduledAt) },
            status: "started",
            data: {
              attempt: event.attempt,
              delayMs: event.delayMs,
              scheduledAt: event.scheduledAt,
            },
          },
        ],
        state,
      };

    case "auto-retry-abandoned":
      return {
        drafts: [
          {
            ts: receivedAt,
            kind: "retry.abandoned",
            source: { system: "chat", key: eventKey("retry-abandoned", receivedAt) },
            status: "failed",
            data: { reason: event.reason },
          },
        ],
        state,
      };

    case "task-created":
      return {
        drafts: [
          {
            ts: event.timestamp,
            kind: "task.created",
            source: { system: "task", key: eventKey("task-created", event.taskId) },
            anchor: { toolCallId: event.toolCallId, taskId: event.taskId },
            status: "started",
          },
        ],
        state,
      };

    case "workflow-run-attached":
      return {
        drafts: [
          {
            ts: event.timestamp,
            kind: "workflow.attached",
            source: { system: "chat", key: eventKey("workflow-attached", event.runId) },
            anchor: {
              ...(event.messageId != null ? { messageId: event.messageId } : {}),
              toolCallId: event.toolCallId,
            },
            data: { runId: event.runId },
          },
        ],
        state,
      };

    case "goal-budget-limited":
      return {
        drafts: [
          {
            ts: receivedAt,
            kind: "goal.budget_limited",
            source: { system: "goal", key: eventKey("goal-budget", event.goalId) },
            anchor:
              event.childWorkspaceId != null
                ? { childWorkspaceId: event.childWorkspaceId }
                : undefined,
            status: "failed",
            data: { goalId: event.goalId, reason: event.message },
          },
        ],
        state,
      };

    default:
      return { drafts: [], state };
  }
}
