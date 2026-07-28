import type { TimelineEventData, TimelineEventDraft } from "@/common/orpc/schemas/timeline";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { getContextBoundaryKind } from "@/common/utils/messages/compactionBoundary";

interface OpenStream {
  workspaceId: string;
  messageId: string;
  historySequence: number;
}

export interface TimelineMapperState {
  readonly openStreams: ReadonlyMap<string, OpenStream>;
}

export interface TimelineMapperResult {
  drafts: TimelineEventDraft[];
  state: TimelineMapperState;
}

export function createTimelineMapperState(): TimelineMapperState {
  return { openStreams: new Map() };
}

function eventKey(...parts: Array<string | number | undefined>): string {
  return parts.filter((part) => part != null).join(":");
}

function streamKey(workspaceId: string, messageId: string): string {
  return eventKey(workspaceId, messageId);
}

function truncateDigest(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
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
    ...anchorMessageId(event.id),
  };
}

// Stream lifecycle events can carry an empty message id; an empty anchor field fails validation and
// would cost the whole row, so omit it rather than anchoring to nothing.
function anchorMessageId(messageId: string | undefined): { messageId?: string } {
  return messageId != null && messageId !== "" ? { messageId } : {};
}

// An empty message id cannot identify a turn, so it must not become a dedupe key: the service
// suppresses repeats of a key, which would silently drop every later id-less failure.
function messageEventKey(prefix: string, messageId: string): string | undefined {
  return messageId === "" ? undefined : eventKey(prefix, messageId);
}

// Mux dispatches several user-role turns on the agent's behalf. They belong on the timeline, but as
// synthetic turns, so the prompts filter stays a record of what the human actually asked for.
const MACHINE_AUTHORED_TURN_TYPES = new Set([
  "heartbeat-request",
  "bash-monitor-wake",
  "workspace-turn-task",
  "workflow-trigger-display",
  "workflow-result",
]);

// muxMetadata crosses the oRPC boundary as `any`, so read its string fields defensively.
function readMuxMetadataField(
  metadata: Extract<WorkspaceChatMessage, { type: "message" }>["metadata"],
  field: "type" | "source"
): string | undefined {
  const muxMetadata: unknown = metadata?.muxMetadata;
  if (typeof muxMetadata !== "object" || muxMetadata === null) {
    return undefined;
  }
  const value = (muxMetadata as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function isMachineAuthoredTurn(
  metadata: Extract<WorkspaceChatMessage, { type: "message" }>["metadata"]
): boolean {
  if (metadata?.synthetic === true) {
    return true;
  }
  const muxType = readMuxMetadataField(metadata, "type");
  return muxType != null && MACHINE_AUTHORED_TURN_TYPES.has(muxType);
}

function mapMessage(
  event: Extract<WorkspaceChatMessage, { type: "message" }>,
  receivedAt: number
): TimelineEventDraft[] {
  const ts = messageTimestamp(event, receivedAt);
  const anchor = messageAnchor(event);
  const epoch = event.metadata?.compactionEpoch;

  if (event.role === "user") {
    // A /compact request is persisted as a user message, but it is Mux asking for a summary, not a
    // prompt the human wrote, so it must not appear among their prompts.
    if (readMuxMetadataField(event.metadata, "type") === "compaction-request") {
      const compactionSource = readMuxMetadataField(event.metadata, "source");
      return [
        {
          ts,
          kind: "compaction.triggered",
          source: { system: "chat", key: eventKey("compaction-request", event.id) },
          anchor,
          ...(epoch != null ? { epoch } : {}),
          status: "started",
          ...(compactionSource != null ? { data: { reason: compactionSource } } : {}),
        },
      ];
    }

    const digest = truncateDigest(
      event.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    );
    return [
      {
        ts,
        kind: isMachineAuthoredTurn(event.metadata) ? "turn.synthetic" : "turn.user",
        source: { system: "chat", key: eventKey("message", event.id) },
        anchor,
        ...(epoch != null ? { epoch } : {}),
        ...(digest !== "" ? { data: { digest } } : {}),
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

function clearMessageState(
  state: TimelineMapperState,
  workspaceId: string | undefined,
  messageId: string
): TimelineMapperState {
  const openStreams = new Map(state.openStreams);
  for (const [key, stream] of openStreams) {
    if (
      stream.messageId === messageId &&
      (workspaceId == null || stream.workspaceId === workspaceId)
    ) {
      openStreams.delete(key);
    }
  }
  return { openStreams };
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
        source: { system: "chat", key: messageEventKey("stream-end", event.messageId) },
        anchor: {
          ...(openStream != null ? { historySequence: openStream.historySequence } : {}),
          ...anchorMessageId(event.messageId),
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
      return {
        drafts: [
          {
            ts: receivedAt,
            kind: "turn.interrupted",
            source: { system: "chat", key: messageEventKey("stream-abort", event.messageId) },
            anchor: {
              ...(openStream != null ? { historySequence: openStream.historySequence } : {}),
              ...anchorMessageId(event.messageId),
            },
            status: "interrupted",
            data: {
              ...(event.abortReason != null ? { reason: event.abortReason } : {}),
              ...(event.metadata?.duration != null ? { durationMs: event.metadata.duration } : {}),
            },
          },
        ],
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
            source: { system: "chat", key: messageEventKey(event.type, event.messageId) },
            anchor: anchorMessageId(event.messageId),
            status: "failed",
            data: {
              reason: event.error,
              ...(event.errorType != null ? { errorKind: event.errorType } : {}),
            },
          },
        ],
        state: clearMessageState(
          state,
          "workspaceId" in event ? event.workspaceId : undefined,
          event.messageId
        ),
      };

    // Automatic compaction persists a `compaction-request` message and, on completion, a boundary
    // summary message. Both are mapped above, with an anchor and a compaction epoch the lifecycle
    // events cannot supply, so mapping these too would put a second row on the same transition.
    case "auto-compaction-triggered":
    case "auto-compaction-completed":
      return { drafts: [], state };

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
            // A task's id is its child workspace id, and the preview card offers "Open child
            // workspace" only when the anchor names one.
            anchor: {
              toolCallId: event.toolCallId,
              taskId: event.taskId,
              childWorkspaceId: event.taskId,
            },
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
              ...anchorMessageId(event.messageId),
              toolCallId: event.toolCallId,
            },
            data: { runId: event.runId },
          },
        ],
        state,
      };

    case "history-cleared":
      return {
        drafts: [
          {
            ts: receivedAt,
            kind: "history.cleared",
            source: { system: "chat", key: eventKey("history-cleared", receivedAt) },
            status: "completed",
            data: { reason: event.reason },
          },
        ],
        state,
      };

    case "goal-budget-limited":
      // WorkspaceGoalService records every transition into budget_limited, including the ones child
      // attribution causes. Mapping this event too would put a second row on the same transition.
      if (event.causedByChild) {
        return { drafts: [], state };
      }
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
