/**
 * Platform-agnostic chat event processor for streaming message accumulation.
 *
 * This module handles the core logic of accumulating streaming events into coherent
 * MuxMessage objects. It's shared between desktop and mobile implementations.
 *
 * Responsibilities:
 * - Accumulate streaming deltas (text, reasoning, tool calls) by messageId
 * - Handle init lifecycle events (init-start, init-output, init-end)
 * - Merge adjacent parts of the same type
 * - Maintain message ordering and metadata
 *
 * NOT responsible for:
 * - UI state management (todos, agent status, recency)
 * - DisplayedMessage transformation (platform-specific)
 * - React/DOM interactions
 */

import type { MuxMessage, MuxMetadata } from "@/common/types/message";
import type { WorkspaceChatMessage } from "@/common/types/ipc";
import {
  isStreamStart,
  isStreamDelta,
  isStreamEnd,
  isStreamAbort,
  isStreamError,
  isToolCallStart,
  isToolCallEnd,
  isReasoningDelta,
  isReasoningEnd,
  isMuxMessage,
  isInitStart,
  isInitOutput,
  isInitEnd,
} from "@/common/types/ipc";
import type {
  DynamicToolPart,
  DynamicToolPartPending,
  DynamicToolPartAvailable,
} from "@/common/types/toolParts";
import type { StreamStartEvent, StreamEndEvent } from "@/common/types/stream";

export interface InitState {
  hookPath: string;
  status: "running" | "success" | "error";
  lines: string[];
  exitCode: number | null;
  timestamp: number;
}

export interface ChatEventProcessor {
  /**
   * Process a single chat event and update internal state.
   */
  handleEvent(event: WorkspaceChatMessage): void;

  /**
   * Get all accumulated messages, ordered by historySequence.
   */
  getMessages(): MuxMessage[];

  /**
   * Get a specific message by ID.
   */
  getMessageById(id: string): MuxMessage | undefined;

  /**
   * Get current init state (if any).
   */
  getInitState(): InitState | null;

  /**
   * Reset processor state (clear all messages and init state).
   */
  reset(): void;

  /**
   * Delete messages by historySequence numbers.
   * Used for history truncation and compaction.
   */
  deleteByHistorySequence(sequences: number[]): void;
}

type ExtendedStreamStartEvent = StreamStartEvent & {
  role?: "user" | "assistant";
  metadata?: Partial<MuxMetadata>;
  timestamp?: number;
};

type ExtendedStreamEndEvent = StreamEndEvent & {
  metadata: StreamEndEvent["metadata"] & Partial<MuxMetadata>;
};

function createMuxMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
  metadata?: MuxMetadata
): MuxMessage {
  const parts: MuxMessage["parts"] = content ? [{ type: "text" as const, text: content }] : [];

  return {
    id,
    role,
    parts,
    metadata,
  };
}

export function createChatEventProcessor(): ChatEventProcessor {
  const messages = new Map<string, MuxMessage>();
  let initState: InitState | null = null;

  const handleEvent = (event: WorkspaceChatMessage): void => {
    // Handle init lifecycle events
    if (isInitStart(event)) {
      initState = {
        hookPath: event.hookPath,
        status: "running",
        lines: [],
        exitCode: null,
        timestamp: event.timestamp,
      };
      return;
    }

    if (isInitOutput(event)) {
      if (!initState) {
        console.error("Received init-output without prior init-start", event);
        return;
      }
      if (typeof event.line !== "string") {
        console.error("Init-output line was not a string", { line: event.line, event });
        return;
      }
      const prefix = event.isError ? "ERROR: " : "";
      initState.lines.push(`${prefix}${event.line}`);
      return;
    }

    if (isInitEnd(event)) {
      if (!initState) {
        console.error("Received init-end without prior init-start", event);
        return;
      }
      initState.status = event.exitCode === 0 ? "success" : "error";
      initState.exitCode = event.exitCode;
      initState.timestamp = event.timestamp;
      return;
    }

    // Handle stream start
    if (isStreamStart(event)) {
      const start = event as ExtendedStreamStartEvent;
      const message = createMuxMessage(start.messageId, start.role ?? "assistant", "", {
        historySequence: start.metadata?.historySequence ?? start.historySequence,
        timestamp: start.metadata?.timestamp ?? start.timestamp,
        model: start.metadata?.model ?? start.model,
        muxMetadata: start.metadata?.muxMetadata,
        partial: true,
      });
      messages.set(start.messageId, message);
      return;
    }

    // Handle deltas
    if (isStreamDelta(event)) {
      const message = messages.get(event.messageId);
      if (!message) {
        console.error("Received stream-delta for unknown message", event.messageId);
        return;
      }

      const lastPart = message.parts.at(-1);
      if (lastPart?.type === "text") {
        lastPart.text += event.delta;
      } else {
        message.parts.push({
          type: "text",
          text: event.delta,
          timestamp: event.timestamp,
        });
      }
      message.metadata = {
        ...message.metadata,
        partial: true,
      };
      return;
    }

    if (isStreamEnd(event)) {
      const message = messages.get(event.messageId);
      if (!message) {
        console.error("Received stream-end for unknown message", event.messageId);
        return;
      }
      const metadata = (event as ExtendedStreamEndEvent).metadata;
      message.metadata = {
        ...message.metadata,
        partial: false,
        timestamp: metadata.timestamp ?? message.metadata?.timestamp,
        model: metadata.model ?? message.metadata?.model ?? event.metadata.model,
        usage: metadata.usage ?? message.metadata?.usage,
        providerMetadata: metadata.providerMetadata ?? message.metadata?.providerMetadata,
        systemMessageTokens: metadata.systemMessageTokens ?? message.metadata?.systemMessageTokens,
        muxMetadata: metadata.muxMetadata ?? message.metadata?.muxMetadata,
        historySequence:
          metadata.historySequence ??
          message.metadata?.historySequence ??
          event.metadata.historySequence,
        toolPolicy: message.metadata?.toolPolicy,
        mode: message.metadata?.mode,
      };
      return;
    }

    if (isStreamAbort(event)) {
      const message = messages.get(event.messageId);
      if (!message) {
        console.error("Received stream-abort for unknown message", event.messageId);
        return;
      }
      message.metadata = {
        ...message.metadata,
        partial: true,
        synthetic: false,
      };
      return;
    }

    if (isStreamError(event)) {
      const message = messages.get(event.messageId);
      if (message) {
        message.metadata = {
          ...message.metadata,
          error: event.error,
          errorType: event.errorType,
        };
      }
      return;
    }

    if (isMuxMessage(event)) {
      messages.set(event.id, event);
      return;
    }

    if (isReasoningDelta(event)) {
      const message = messages.get(event.messageId);
      if (!message) {
        console.error("Received reasoning-delta for unknown message", event.messageId);
        return;
      }

      const lastPart = message.parts.at(-1);
      if (lastPart?.type === "reasoning") {
        lastPart.text += event.delta;
      } else {
        message.parts.push({
          type: "reasoning",
          text: event.delta,
          timestamp: event.timestamp,
        });
      }
      return;
    }

    if (isReasoningEnd(event)) {
      return;
    }

    if (isToolCallStart(event)) {
      const message = messages.get(event.messageId);
      if (!message) {
        console.error("Received tool-call-start for unknown message", event.messageId);
        return;
      }

      const existingToolPart = message.parts.find(
        (part): part is DynamicToolPart =>
          part.type === "dynamic-tool" && part.toolCallId === event.toolCallId
      );

      if (existingToolPart) {
        console.warn(`Tool call ${event.toolCallId} already exists, skipping duplicate`);
        return;
      }

      const toolPart: DynamicToolPartPending = {
        type: "dynamic-tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        state: "input-available",
        input: event.args,
        timestamp: event.timestamp,
      };
      message.parts.push(toolPart as never);
      return;
    }

    if (isToolCallEnd(event)) {
      const message = messages.get(event.messageId);
      if (!message) {
        console.error("Received tool-call-end for unknown message", event.messageId);
        return;
      }

      const toolPart = message.parts.find(
        (part): part is DynamicToolPart =>
          part.type === "dynamic-tool" && part.toolCallId === event.toolCallId
      );

      if (toolPart) {
        (toolPart as DynamicToolPartAvailable).state = "output-available";
        (toolPart as DynamicToolPartAvailable).output = event.result;
      } else {
        console.error("Received tool-call-end for unknown tool call", event.toolCallId);
      }
      return;
    }
  };

  const getMessages = (): MuxMessage[] => {
    return Array.from(messages.values()).sort((a, b) => {
      const seqA = a.metadata?.historySequence ?? 0;
      const seqB = b.metadata?.historySequence ?? 0;
      return seqA - seqB;
    });
  };

  const getMessageById = (id: string): MuxMessage | undefined => {
    return messages.get(id);
  };

  const getInitState = (): InitState | null => {
    return initState;
  };

  const reset = (): void => {
    messages.clear();
    initState = null;
  };

  const deleteByHistorySequence = (sequences: number[]): void => {
    const sequencesToDelete = new Set(sequences);
    const messagesToRemove: string[] = [];

    for (const [messageId, message] of messages.entries()) {
      const historySeq = message.metadata?.historySequence;
      if (historySeq !== undefined && sequencesToDelete.has(historySeq)) {
        messagesToRemove.push(messageId);
      }
    }

    for (const messageId of messagesToRemove) {
      messages.delete(messageId);
    }
  };

  return {
    handleEvent,
    getMessages,
    getMessageById,
    getInitState,
    reset,
    deleteByHistorySequence,
  };
}
