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
  messageId: string,
  eventType: string
): { ok: true } | { ok: false; error: Error } {
  if (!state.activeMessageId) {
    state.activeMessageId = messageId;
    return { ok: true };
  }

  if (state.activeMessageId !== messageId) {
    return {
      ok: false,
      error: new Error(
        `Received ${eventType} for unexpected message ${messageId}; active stream is ${state.activeMessageId}`
      ),
    };
  }

  return { ok: true };
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
  // noCache = inputTokens - cachedInputTokens). Including both would
  // double-count cached tokens.
  const counts = [usage.inputTokens, usage.outputTokens, usage.reasoningTokens];

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
    const match = ensureMessageId(state, event.messageId, event.type);
    if (!match.ok) {
      return { kind: "error", error: match.error };
    }
    return { kind: "ignore" };
  }

  if (isStreamDelta(event)) {
    const match = ensureMessageId(state, event.messageId, event.type);
    if (!match.ok) {
      return { kind: "error", error: match.error };
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
      return { kind: "error", error: match.error };
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
      return { kind: "error", error: match.error };
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
      return { kind: "error", error: match.error };
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
      return { kind: "error", error: match.error };
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
    if (state.activeMessageId != null && event.messageId !== state.activeMessageId) {
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
      return { kind: "error", error: match.error };
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
      return { kind: "error", error: match.error };
    }

    state.activeMessageId = null;
    return {
      kind: "stop",
      stopReason: mapAbortReasonToStopReason(event.abortReason),
    };
  }

  if (isStreamError(event)) {
    // Only treat stream errors as fatal if they belong to the active message.
    // During reconnect/interruption races, stale errors from a previous stream
    // should be ignored rather than aborting the current prompt.
    const match = ensureMessageId(state, event.messageId, event.type);
    if (!match.ok) {
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
