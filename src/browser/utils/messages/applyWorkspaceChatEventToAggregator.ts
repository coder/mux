import assert from "@/common/utils/assert";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { MUX_GATEWAY_SESSION_EXPIRED_MESSAGE } from "@/common/constants/muxGatewayOAuth";
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
  isRuntimeStatus,
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
  RuntimeStatusEvent,
} from "@/common/types/stream";

export type WorkspaceChatEventUpdateHint = "immediate" | "throttled" | "ignored";

export interface ApplyWorkspaceChatEventToAggregatorOptions {
  /**
   * When false, suppress side effects (e.g. toasts / localStorage writes) when replaying history.
   *
   * Defaults to true.
   */
  allowSideEffects?: boolean;
}

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

  handleRuntimeStatus(data: RuntimeStatusEvent): void;

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
  event: WorkspaceChatMessage,
  options?: ApplyWorkspaceChatEventToAggregatorOptions
): WorkspaceChatEventUpdateHint {
  assert(aggregator, "applyWorkspaceChatEventToAggregator requires aggregator");
  assert(
    event && typeof event === "object",
    "applyWorkspaceChatEventToAggregator requires event object"
  );

  const allowSideEffects = options?.allowSideEffects !== false;

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
    if (allowSideEffects && event.error === MUX_GATEWAY_SESSION_EXPIRED_MESSAGE) {
      // Dispatch session-expired event; useGateway() listens for it and
      // optimistically marks the gateway as unconfigured to stop routing.
      if (typeof window !== "undefined") {
        window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED));
      }
    }

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

  // runtime-status events are used for Coder workspace starting UX
  if (isRuntimeStatus(event)) {
    aggregator.handleRuntimeStatus(event);
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
    ("type" in event && event.type === "auto-compaction-triggered") ||
    ("type" in event && event.type === "auto-compaction-completed") ||
    ("type" in event && event.type === "idle-compaction-started")
  ) {
    return "ignored";
  }

  // Forward-compatible default: new event types should not crash older clients.
  return "ignored";
}
