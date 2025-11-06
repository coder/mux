/**
 * Platform-agnostic chat event processor for streaming message accumulation.
 * 
 * This module handles the core logic of accumulating streaming events into coherent
 * CmuxMessage objects. It's shared between desktop and mobile implementations.
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

import type { CmuxMessage, CmuxMetadata } from "../../types/message";
import type { WorkspaceChatMessage } from "../../types/ipc";
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
  isCmuxMessage,
  isInitStart,
  isInitOutput,
  isInitEnd,
  type WorkspaceInitEvent,
} from "../../types/ipc";
import type {
  DynamicToolPart,
  DynamicToolPartPending,
  DynamicToolPartAvailable,
} from "../../types/toolParts";

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
  getMessages(): CmuxMessage[];

  /**
   * Get a specific message by ID.
   */
  getMessageById(id: string): CmuxMessage | undefined;

  /**
   * Get current init state (if any).
   */
  getInitState(): InitState | null;

  /**
   * Reset processor state (clear all messages and init state).
   */
  reset(): void;
}

/**
 * Create a helper for CmuxMessage creation
 */
function createCmuxMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
  metadata?: CmuxMetadata
): CmuxMessage {
  const parts: CmuxMessage["parts"] = content
    ? [{ type: "text" as const, text: content }]
    : [];

  return {
    id,
    role,
    parts,
    metadata,
  };
}

export function createChatEventProcessor(): ChatEventProcessor {
  // Message storage keyed by messageId
  const messages = new Map<string, CmuxMessage>();

  // Init hook state (ephemeral, not persisted)
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
      const line = event.isError ? `ERROR: ${event.line}` : event.line;
      initState.lines.push(line.trimEnd());
      return;
    }

    if (isInitEnd(event)) {
      if (!initState) {
        console.error("Received init-end without prior init-start", event);
        return;
      }
      initState.exitCode = event.exitCode;
      initState.status = event.exitCode === 0 ? "success" : "error";
      initState.timestamp = event.timestamp;
      return;
    }

    // Handle complete messages (from history or reconnection)
    if (isCmuxMessage(event)) {
      const incomingMessage = event;
      const incomingSequence = incomingMessage.metadata?.historySequence;

      // Smart replacement logic for edits
      if (incomingSequence !== undefined) {
        const messagesToRemove: string[] = [];
        for (const [removeId, removeMsg] of messages.entries()) {
          const removeSeq = removeMsg.metadata?.historySequence;
          if (removeSeq !== undefined && removeSeq >= incomingSequence) {
            messagesToRemove.push(removeId);
          }
        }
        for (const removeId of messagesToRemove) {
          messages.delete(removeId);
        }
      }

      messages.set(incomingMessage.id, incomingMessage);
      return;
    }

    // Handle streaming lifecycle events
    if (isStreamStart(event)) {
      const streamingMessage = createCmuxMessage(event.messageId, "assistant", "", {
        historySequence: event.historySequence,
        timestamp: Date.now(),
        model: event.model,
      });
      messages.set(event.messageId, streamingMessage);
      return;
    }

    if (isStreamDelta(event)) {
      const message = messages.get(event.messageId);
      if (!message) {
        console.error("Received stream-delta for unknown message", event.messageId);
        return;
      }
      message.parts.push({
        type: "text",
        text: event.delta,
        timestamp: event.timestamp,
      });
      return;
    }

    if (isStreamEnd(event)) {
      const message = messages.get(event.messageId);
      if (message?.metadata) {
        // Merge metadata from stream-end
        message.metadata = {
          ...message.metadata,
          ...event.metadata,
        };

        // Update tool parts with results if provided
        if (event.parts) {
          for (const backendPart of event.parts) {
            if (backendPart.type === "dynamic-tool") {
              const toolPart = message.parts.find(
                (part): part is DynamicToolPart =>
                  part.type === "dynamic-tool" &&
                  (part as DynamicToolPart).toolCallId === backendPart.toolCallId
              );
              if (toolPart) {
                (toolPart as DynamicToolPartAvailable).output = backendPart.output;
                (toolPart as DynamicToolPartAvailable).state = "output-available";
              }
            }
          }
        }
      } else if (!message) {
        // Reconnection case: create message from stream-end
        const completeMessage: CmuxMessage = {
          id: event.messageId,
          role: "assistant",
          metadata: {
            ...event.metadata,
            timestamp: event.metadata.timestamp ?? Date.now(),
          },
          parts: event.parts,
        };
        messages.set(event.messageId, completeMessage);
      }
      return;
    }

    if (isStreamAbort(event)) {
      const message = messages.get(event.messageId);
      if (message?.metadata) {
        message.metadata = {
          ...message.metadata,
          partial: true,
          ...event.metadata,
        };
      }
      return;
    }

    if (isStreamError(event)) {
      const message = messages.get(event.messageId);
      if (message?.metadata) {
        message.metadata.partial = true;
        message.metadata.error = event.error;
        message.metadata.errorType = event.errorType;
      }
      return;
    }

    // Handle reasoning lifecycle
    if (isReasoningDelta(event)) {
      const message = messages.get(event.messageId);
      if (!message) {
        console.error("Received reasoning-delta for unknown message", event.messageId);
        return;
      }
      message.parts.push({
        type: "reasoning",
        text: event.delta,
        timestamp: event.timestamp,
      });
      return;
    }

    if (isReasoningEnd(event)) {
      // Reasoning-end is just a signal - no state to update
      return;
    }

    // Handle tool call lifecycle
    if (isToolCallStart(event)) {
      const message = messages.get(event.messageId);
      if (!message) {
        console.error("Received tool-call-start for unknown message", event.messageId);
        return;
      }

      // Check for duplicates
      const existingToolPart = message.parts.find(
        (part): part is DynamicToolPart =>
          part.type === "dynamic-tool" &&
          (part as DynamicToolPart).toolCallId === event.toolCallId
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

    // Ignore tool-call-delta (streaming args display - not needed for message structure)
    // Ignore delete events (handled at higher level)
    // Ignore caught-up events (coordination signal)
  };

  const getMessages = (): CmuxMessage[] => {
    return Array.from(messages.values()).sort((a, b) => {
      const seqA = a.metadata?.historySequence ?? 0;
      const seqB = b.metadata?.historySequence ?? 0;
      return seqA - seqB;
    });
  };

  const getMessageById = (id: string): CmuxMessage | undefined => {
    return messages.get(id);
  };

  const getInitState = (): InitState | null => {
    return initState;
  };

  const reset = (): void => {
    messages.clear();
    initState = null;
  };

  return {
    handleEvent,
    getMessages,
    getMessageById,
    getInitState,
    reset,
  };
}
