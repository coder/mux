import type * as schema from "@agentclientprotocol/sdk";
import {
  isReasoningDelta,
  isStreamAbort,
  isStreamDelta,
  isStreamEnd,
  isStreamError,
  isStreamStart,
  isToolCallDelta,
  isToolCallEnd,
  isToolCallStart,
  isUsageDelta,
  type WorkspaceChatMessage,
} from "@/common/orpc/types";
import assert from "@/common/utils/assert";

export interface UpdateMappingState {
  activeMessageId: string | null;
}

export type MappedWorkspaceEvent =
  | { kind: "ignore" }
  | { kind: "update"; update: schema.SessionUpdate }
  | { kind: "stop"; stopReason: schema.StopReason }
  | { kind: "error"; error: Error };

export function createUpdateMappingState(): UpdateMappingState {
  return {
    activeMessageId: null,
  };
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    const json = JSON.stringify(value, null, 2);
    if (typeof json === "string") {
      return json;
    }
  } catch {
    // Fall through to String() for values that throw during serialization.
  }

  return String(value);
}

function asTextContentBlock(text: string): schema.ContentBlock {
  return {
    type: "text",
    text,
  };
}

function asToolTextContent(text: string): schema.ToolCallContent {
  return {
    type: "content",
    content: asTextContentBlock(text),
  };
}

function ensureMessageId(
  state: UpdateMappingState,
  messageId: string | undefined,
  eventType: string,
  opts?: { allowInitialization?: boolean }
): { ok: true } | { ok: false } {
  assert(eventType.length > 0, "event type must be non-empty");

  if (typeof messageId !== "string" || messageId.length === 0) {
    return { ok: false };
  }

  if (!state.activeMessageId) {
    if (opts?.allowInitialization) {
      state.activeMessageId = messageId;
      return { ok: true };
    }

    return { ok: false };
  }

  if (state.activeMessageId !== messageId) {
    return { ok: false };
  }

  return { ok: true };
}

function createUnexpectedMessageIdError(
  eventType: string,
  messageId: string | undefined,
  activeMessageId: string | null
): Error {
  const receivedMessageId = messageId ?? "<missing>";
  const activeStreamId = activeMessageId ?? "<none>";
  return new Error(
    `Received ${eventType} for unexpected message ${receivedMessageId}; active stream is ${activeStreamId}`
  );
}

function mapNonStartMessageIdMismatch(
  state: UpdateMappingState,
  eventType: string,
  messageId: string | undefined
): { kind: "ignore" } | { kind: "error"; error: Error } {
  if (state.activeMessageId == null) {
    return { kind: "ignore" };
  }

  return {
    kind: "error",
    error: createUnexpectedMessageIdError(eventType, messageId, state.activeMessageId),
  };
}

function toUsageTokenCount(usage: {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}): number {
  // Only trust totalTokens when it's a positive finite number. Stream accumulators
  // may produce totalTokens: 0 when providers omit totals (addUsage in usageHelpers.ts
  // defaults missing totals to 0), so 0 should fall through to the counter-based sum.
  if (
    typeof usage.totalTokens === "number" &&
    Number.isFinite(usage.totalTokens) &&
    usage.totalTokens > 0
  ) {
    return Math.trunc(usage.totalTokens);
  }

  // Note: cachedInputTokens are already included in inputTokens
  // (see flatUsageToV3 in gatewayStreamNormalization.ts which derives
  // noCache = inputTokens - cachedInputTokens), and reasoningTokens are
  // already part of outputTokens (see createDisplayUsage which computes
  // outputWithoutReasoning = outputTokens - reasoningTokens). Including
  // any of those would double-count tokens.
  const counts = [usage.inputTokens, usage.outputTokens];

  let total = 0;
  for (const count of counts) {
    if (typeof count === "number" && Number.isFinite(count)) {
      total += Math.max(0, Math.trunc(count));
    }
  }

  return total;
}

function mapAbortReasonToStopReason(abortReason: string | undefined): schema.StopReason {
  return abortReason === "user" ? "cancelled" : "end_turn";
}

export function mapWorkspaceChatEventToAcp(
  event: WorkspaceChatMessage,
  state: UpdateMappingState,
  unstableEnabled: boolean
): MappedWorkspaceEvent {
  if ((event as { type?: string }).type === "heartbeat") {
    return { kind: "ignore" };
  }

  if (isStreamStart(event)) {
    const match = ensureMessageId(state, event.messageId, event.type, {
      allowInitialization: true,
    });
    if (!match.ok) {
      return {
        kind: "error",
        error: createUnexpectedMessageIdError(event.type, event.messageId, state.activeMessageId),
      };
    }
    return { kind: "ignore" };
  }

  if (isStreamDelta(event)) {
    const match = ensureMessageId(state, event.messageId, event.type);
    if (!match.ok) {
      return mapNonStartMessageIdMismatch(state, event.type, event.messageId);
    }

    assert(typeof event.delta === "string", "stream delta must be text");
    return {
      kind: "update",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: asTextContentBlock(event.delta),
      },
    };
  }

  if (isReasoningDelta(event)) {
    const match = ensureMessageId(state, event.messageId, event.type);
    if (!match.ok) {
      return mapNonStartMessageIdMismatch(state, event.type, event.messageId);
    }

    return {
      kind: "update",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: asTextContentBlock(event.delta),
      },
    };
  }

  if (isToolCallStart(event)) {
    const match = ensureMessageId(state, event.messageId, event.type);
    if (!match.ok) {
      return mapNonStartMessageIdMismatch(state, event.type, event.messageId);
    }

    return {
      kind: "update",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: event.toolCallId,
        title: event.toolName,
        status: "in_progress",
        rawInput: event.args,
      },
    };
  }

  if (isToolCallDelta(event)) {
    const match = ensureMessageId(state, event.messageId, event.type);
    if (!match.ok) {
      return mapNonStartMessageIdMismatch(state, event.type, event.messageId);
    }

    const deltaText = stringifyUnknown(event.delta);
    const content = deltaText.length > 0 ? [asToolTextContent(deltaText)] : undefined;

    return {
      kind: "update",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        status: "in_progress",
        content,
      },
    };
  }

  if (isToolCallEnd(event)) {
    const match = ensureMessageId(state, event.messageId, event.type);
    if (!match.ok) {
      return mapNonStartMessageIdMismatch(state, event.type, event.messageId);
    }

    const outputText = stringifyUnknown(event.result);
    const content = outputText.length > 0 ? [asToolTextContent(outputText)] : undefined;

    return {
      kind: "update",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        status: "completed",
        rawOutput: event.result,
        content,
      },
    };
  }

  if (isUsageDelta(event)) {
    if (!unstableEnabled) {
      return { kind: "ignore" };
    }

    // Ignore stale usage events from a prior stream to avoid attributing
    // wrong token counts to the current prompt during stream overlap.
    const match = ensureMessageId(state, event.messageId, event.type);
    if (!match.ok) {
      return { kind: "ignore" };
    }

    const tokenCount = toUsageTokenCount(event.cumulativeUsage);

    return {
      kind: "update",
      update: {
        sessionUpdate: "usage_update",
        used: tokenCount,
        size: tokenCount,
      },
    };
  }

  if (isStreamEnd(event)) {
    const match = ensureMessageId(state, event.messageId, event.type);
    if (!match.ok) {
      return mapNonStartMessageIdMismatch(state, event.type, event.messageId);
    }

    state.activeMessageId = null;
    return {
      kind: "stop",
      stopReason: "end_turn",
    };
  }

  if (isStreamAbort(event)) {
    const match = ensureMessageId(state, event.messageId, event.type);
    if (!match.ok) {
      return mapNonStartMessageIdMismatch(state, event.type, event.messageId);
    }

    state.activeMessageId = null;
    return {
      kind: "stop",
      stopReason: mapAbortReasonToStopReason(event.abortReason),
    };
  }

  if (isStreamError(event)) {
    // Stream startup can fail before any stream-start event is emitted. In that
    // case activeMessageId is still null, and ignoring the stream-error would
    // leave the pump waiting indefinitely for a stop event.
    const match = ensureMessageId(state, event.messageId, event.type);
    if (!match.ok) {
      if (state.activeMessageId == null) {
        return {
          kind: "error",
          error: new Error(event.error),
        };
      }

      // During reconnect/interruption races, stale errors from a previous stream
      // should not abort the currently active stream.
      return { kind: "ignore" };
    }

    return {
      kind: "error",
      error: new Error(event.error),
    };
  }

  if ((event as { type?: string }).type === "error") {
    const streamError = event as Extract<WorkspaceChatMessage, { type: "error" }>;
    return {
      kind: "error",
      error: new Error(streamError.error),
    };
  }

  return { kind: "ignore" };
}
