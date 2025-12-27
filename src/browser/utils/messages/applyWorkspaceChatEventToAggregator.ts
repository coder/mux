import assert from "@/common/utils/assert";
import type { DeleteMessage, StreamErrorMessage, WorkspaceChatMessage } from "@/common/orpc/types";
import {
  isBashOutputEvent,
  isCaughtUpMessage,
  isDeleteMessage,
  isInitEnd,
  isInitOutput,
  isInitStart,
  isMuxMessage,
  isQueuedMessageChanged,
  isReasoningDelta,
  isReasoningEnd,
  isRestoreToInput,
  isStreamAbort,
  isStreamDelta,
  isStreamEnd,
  isStreamError,
  isStreamStart,
  isToolCallDelta,
  isToolCallEnd,
  isToolCallStart,
  isUsageDelta,
} from "@/common/orpc/types";
import type {
  ReasoningDeltaEvent,
  ReasoningEndEvent,
  StreamAbortEvent,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  UsageDeltaEvent,
} from "@/common/types/stream";

export type WorkspaceChatEventUpdateHint = "immediate" | "throttled" | "ignored";

/**
 * Minimal interface required by applyWorkspaceChatEventToAggregator.
 *
 * Using an interface (instead of depending on the concrete StreamingMessageAggregator class)
 * makes this function easy to unit test with a stub aggregator.
 */
export interface WorkspaceChatEventAggregator {
  handleStreamStart(data: StreamStartEvent): void;
  handleStreamDelta(data: StreamDeltaEvent): void;
  handleStreamEnd(data: StreamEndEvent): void;
  handleStreamAbort(data: StreamAbortEvent): void;
  handleStreamError(data: StreamErrorMessage): void;

  handleToolCallStart(data: ToolCallStartEvent): void;
  handleToolCallDelta(data: ToolCallDeltaEvent): void;
  handleToolCallEnd(data: ToolCallEndEvent): void;

  handleReasoningDelta(data: ReasoningDeltaEvent): void;
  handleReasoningEnd(data: ReasoningEndEvent): void;

  handleUsageDelta(data: UsageDeltaEvent): void;

  handleDeleteMessage(data: DeleteMessage): void;

  handleMessage(data: WorkspaceChatMessage): void;

  clearTokenState(messageId: string): void;
}

/**
 * Applies a single workspace chat event to a StreamingMessageAggregator-like instance.
 *
 * Returns an update hint for UI callers:
 * - "throttled": high-frequency events (deltas) where callers should coalesce re-renders
 * - "immediate": state changed and callers should update UI immediately
 * - "ignored": event does not affect the aggregator
 */
export function applyWorkspaceChatEventToAggregator(
  aggregator: WorkspaceChatEventAggregator,
  event: WorkspaceChatMessage
): WorkspaceChatEventUpdateHint {
  assert(aggregator, "applyWorkspaceChatEventToAggregator requires aggregator");
  assert(
    event && typeof event === "object",
    "applyWorkspaceChatEventToAggregator requires event object"
  );

  if (isStreamStart(event)) {
    aggregator.handleStreamStart(event);
    return "immediate";
  }

  if (isStreamDelta(event)) {
    aggregator.handleStreamDelta(event);
    return "throttled";
  }

  if (isStreamEnd(event)) {
    aggregator.handleStreamEnd(event);
    aggregator.clearTokenState(event.messageId);
    return "immediate";
  }

  if (isStreamAbort(event)) {
    // Keep ordering consistent with WorkspaceStore (token state cleared immediately on abort).
    aggregator.clearTokenState(event.messageId);
    aggregator.handleStreamAbort(event);
    return "immediate";
  }

  if (isStreamError(event)) {
    aggregator.handleStreamError(event);
    return "immediate";
  }

  if (isToolCallStart(event)) {
    aggregator.handleToolCallStart(event);
    return "immediate";
  }

  if (isToolCallDelta(event)) {
    aggregator.handleToolCallDelta(event);
    return "throttled";
  }

  if (isToolCallEnd(event)) {
    aggregator.handleToolCallEnd(event);
    return "immediate";
  }

  if (isReasoningDelta(event)) {
    aggregator.handleReasoningDelta(event);
    return "throttled";
  }

  if (isReasoningEnd(event)) {
    aggregator.handleReasoningEnd(event);
    return "immediate";
  }

  if (isUsageDelta(event)) {
    aggregator.handleUsageDelta(event);
    return "throttled";
  }

  if (isDeleteMessage(event)) {
    aggregator.handleDeleteMessage(event);
    return "immediate";
  }

  // init-* and ChatMuxMessage are handled via the aggregator's unified handleMessage.
  if (isMuxMessage(event) || isInitStart(event) || isInitOutput(event) || isInitEnd(event)) {
    aggregator.handleMessage(event);
    return "immediate";
  }

  // Events that are intentionally NOT applied to the aggregator (but may still be useful to callers).
  if (
    isCaughtUpMessage(event) ||
    isQueuedMessageChanged(event) ||
    isRestoreToInput(event) ||
    isBashOutputEvent(event) ||
    ("type" in event && event.type === "session-usage-delta") ||
    ("type" in event && event.type === "idle-compaction-needed")
  ) {
    return "ignored";
  }

  // Forward-compatible default: new event types should not crash older clients.
  return "ignored";
}
