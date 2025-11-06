import type { DisplayedMessage, WorkspaceChatEvent } from "../types";
import type { CmuxMessage, CmuxTextPart, CmuxReasoningPart, CmuxImagePart } from "@shared/types/message.ts";
import type { DynamicToolPart } from "@shared/types/toolParts.ts";
import { createChatEventProcessor, type ChatEventProcessor } from "@shared/utils/messages/ChatEventProcessor.ts";

interface CmuxMessageLike {
  id?: string;
  role?: string;
  parts?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

type IncomingEvent = WorkspaceChatEvent | DisplayedMessage | CmuxMessageLike | string | number | null | undefined;

interface ChatEventExpander {
  expand(event: IncomingEvent | IncomingEvent[]): WorkspaceChatEvent[];
}

export const DISPLAYABLE_MESSAGE_TYPES: ReadonlySet<DisplayedMessage["type"]> = new Set([
  "user",
  "assistant",
  "tool",
  "reasoning",
  "stream-error",
  "history-hidden",
  "workspace-init",
]);

const PASS_THROUGH_TYPES = new Set([
  "delete",
  "status",
  "error",
  "stream-error",
  "caught-up",
]);

const INIT_MESSAGE_ID = "workspace-init";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCmuxMessageLike(value: unknown): value is CmuxMessageLike {
  if (!isObject(value)) {
    return false;
  }
  const role = value.role;
  const parts = value.parts;
  return typeof role === "string" && Array.isArray(parts);
}

function getMetadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!metadata) {
    return undefined;
  }
  const candidate = metadata[key];
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return candidate;
  }
  if (typeof candidate === "string") {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractTextFromPart(part: Record<string, unknown>): string {
  if (typeof part.text === "string") {
    return part.text;
  }
  if (isObject(part.text) && typeof part.text.value === "string") {
    return part.text.value;
  }
  if (typeof part.output === "string") {
    return part.output;
  }
  return "";
}

function extractReasoningFromPart(part: Record<string, unknown>): string {
  if (typeof part.reasoning === "string") {
    return part.reasoning;
  }
  if (isObject(part.reasoning) && typeof part.reasoning.value === "string") {
    return part.reasoning.value;
  }
  return "";
}

function buildDisplayedMessagesFromCmux(message: CmuxMessageLike): DisplayedMessage[] {
  // Convert CmuxMessageLike to proper CmuxMessage and use transformCmuxToDisplayed
  // This ensures consistent tool/reasoning handling across all message sources
  const metadata = isObject(message.metadata) ? message.metadata : undefined;
  const historySequence = getMetadataNumber(metadata, "historySequence") ?? Date.now();
  const timestamp = getMetadataNumber(metadata, "createdAt") ?? getMetadataNumber(metadata, "timestamp");
  const model = typeof metadata?.model === "string" ? metadata.model : undefined;
  
  const cmuxMessage: CmuxMessage = {
    id: message.id ?? `msg-${historySequence}`,
    role: (typeof message.role === "string" ? message.role : "assistant") as "user" | "assistant",
    parts: (message.parts ?? []) as CmuxMessage["parts"],
    metadata: {
      historySequence,
      timestamp,
      model,
    },
  };

  return transformCmuxToDisplayed(cmuxMessage);
}

/**
 * Helper to check if a result indicates failure (for tools that return { success: boolean })
 */
function hasFailureResult(result: unknown): boolean {
  if (typeof result === "object" && result !== null && "success" in result) {
    return (result as { success: boolean }).success === false;
  }
  return false;
}

/**
 * Transform CmuxMessage into DisplayedMessage array.
 * Handles merging adjacent text/reasoning parts and extracting tool calls.
 */
function transformCmuxToDisplayed(message: CmuxMessage): DisplayedMessage[] {
  const displayed: DisplayedMessage[] = [];
  const historySequence = message.metadata?.historySequence ?? 0;
  const baseTimestamp = message.metadata?.timestamp;
  let streamSeq = 0;

  if (message.role === "user") {
    const content = message.parts
      .filter((p): p is CmuxTextPart => p.type === "text")
      .map((p) => p.text)
      .join("");

    const imageParts = message.parts
      .filter((p): p is CmuxImagePart => p.type === "file")
      .map((p) => ({
        url: p.url,
        mediaType: p.mediaType,
      }));

    displayed.push({
      type: "user",
      id: message.id,
      historyId: message.id,
      content,
      imageParts: imageParts.length > 0 ? imageParts : undefined,
      historySequence,
      timestamp: baseTimestamp,
    });
  } else if (message.role === "assistant") {
    // Merge adjacent parts of same type
    const mergedParts: typeof message.parts = [];
    for (const part of message.parts) {
      const lastMerged = mergedParts[mergedParts.length - 1];

      if (lastMerged?.type === "text" && part.type === "text") {
        mergedParts[mergedParts.length - 1] = {
          type: "text",
          text: lastMerged.text + part.text,
          timestamp: lastMerged.timestamp ?? part.timestamp,
        };
      } else if (lastMerged?.type === "reasoning" && part.type === "reasoning") {
        mergedParts[mergedParts.length - 1] = {
          type: "reasoning",
          text: lastMerged.text + part.text,
          timestamp: lastMerged.timestamp ?? part.timestamp,
        };
      } else {
        mergedParts.push(part);
      }
    }

    // Find last part index for isLastPartOfMessage flag
    let lastPartIndex = -1;
    for (let i = mergedParts.length - 1; i >= 0; i--) {
      const part = mergedParts[i];
      if (
        part.type === "reasoning" ||
        (part.type === "text" && part.text) ||
        part.type === "dynamic-tool"
      ) {
        lastPartIndex = i;
        break;
      }
    }

    mergedParts.forEach((part, partIndex) => {
      const isLastPart = partIndex === lastPartIndex;

      if (part.type === "reasoning") {
        displayed.push({
          type: "reasoning",
          id: `${message.id}-${partIndex}`,
          historyId: message.id,
          content: part.text,
          historySequence,
          streamSequence: streamSeq++,
          isStreaming: false,
          isPartial: message.metadata?.partial ?? false,
          isLastPartOfMessage: isLastPart,
          timestamp: part.timestamp ?? baseTimestamp,
        });
      } else if (part.type === "text" && part.text) {
        displayed.push({
          type: "assistant",
          id: `${message.id}-${partIndex}`,
          historyId: message.id,
          content: part.text,
          historySequence,
          streamSequence: streamSeq++,
          isStreaming: false,
          isPartial: message.metadata?.partial ?? false,
          isLastPartOfMessage: isLastPart,
          isCompacted: message.metadata?.compacted ?? false,
          model: message.metadata?.model,
          timestamp: part.timestamp ?? baseTimestamp,
        });
      } else if (part.type === "dynamic-tool") {
        const toolPart = part as DynamicToolPart;
        let status: "pending" | "executing" | "completed" | "failed" | "interrupted";
        
        if (toolPart.state === "output-available") {
          status = hasFailureResult(toolPart.output) ? "failed" : "completed";
        } else if (toolPart.state === "input-available" && message.metadata?.partial) {
          status = "interrupted";
        } else if (toolPart.state === "input-available") {
          status = "executing";
        } else {
          status = "pending";
        }

        displayed.push({
          type: "tool",
          id: `${message.id}-${partIndex}`,
          historyId: message.id,
          toolCallId: toolPart.toolCallId,
          toolName: toolPart.toolName,
          args: toolPart.input,
          result: toolPart.state === "output-available" ? toolPart.output : undefined,
          status,
          isPartial: message.metadata?.partial ?? false,
          historySequence,
          streamSequence: streamSeq++,
          isLastPartOfMessage: isLastPart,
          timestamp: toolPart.timestamp ?? baseTimestamp,
        });
      }
    });

    // Add stream-error if message has error metadata
    if (message.metadata?.error) {
      displayed.push({
        type: "stream-error",
        id: `${message.id}-error`,
        historyId: message.id,
        error: message.metadata.error,
        errorType: message.metadata.errorType ?? "unknown",
        historySequence,
        model: message.metadata.model,
        timestamp: baseTimestamp,
      });
    }
  }

  return displayed;
}

export function createChatEventExpander(): ChatEventExpander {
  const processor = createChatEventProcessor();
  const unsupportedTypesLogged = new Set<string>();
  
  // Track active streams for real-time emission
  const activeStreams = new Set<string>();

  const emitInitMessage = (): DisplayedMessage[] => {
    const initState = processor.getInitState();
    if (!initState) {
      return [];
    }
    return [
      {
        type: "workspace-init",
        id: INIT_MESSAGE_ID,
        historySequence: -1,
        status: initState.status,
        hookPath: initState.hookPath,
        lines: [...initState.lines],
        exitCode: initState.exitCode,
        timestamp: initState.timestamp,
      },
    ];
  };
  
  /**
   * Emit partial messages for active stream.
   * Called during streaming to show real-time updates.
   */
  const emitPartialMessages = (messageId: string): WorkspaceChatEvent[] => {
    const message = processor.getMessageById(messageId);
    if (!message) {
      return [];
    }
    
    const displayed = transformCmuxToDisplayed(message);
    
    // Mark displayed parts as streaming (except completed/failed tools)
    displayed.forEach((msg) => {
      // Don't mark completed or failed tools as streaming
      if (msg.type === 'tool') {
        const toolMsg = msg as DisplayedMessage & { type: 'tool'; status: string };
        if (toolMsg.status === 'completed' || toolMsg.status === 'failed') {
          // Tool is done, don't mark as streaming
          return;
        }
      }
      
      if ('isStreaming' in msg) {
        (msg as any).isStreaming = true;
      }
      if ('isPartial' in msg) {
        (msg as any).isPartial = true;
      }
    });
    
    return displayed;
  };

  const expandSingle = (payload: IncomingEvent | undefined): WorkspaceChatEvent[] => {
    if (!payload) {
      return [];
    }

    // Handle legacy CmuxMessage-like objects (from old serialization)
    if (isCmuxMessageLike(payload)) {
      return buildDisplayedMessagesFromCmux(payload);
    }

    if (Array.isArray(payload)) {
      return payload.flatMap((item) => expandSingle(item));
    }

    if (typeof payload === "string" || typeof payload === "number") {
      return [payload as WorkspaceChatEvent];
    }

    if (isObject(payload) && typeof payload.type === "string") {
      // Check if it's an already-formed DisplayedMessage (from backend)
      if (
        "historySequence" in payload &&
        DISPLAYABLE_MESSAGE_TYPES.has(payload.type as DisplayedMessage["type"])
      ) {
        return [payload as DisplayedMessage];
      }

      const type = payload.type;

      // Emit init message updates
      if (type === "init-start" || type === "init-output" || type === "init-end") {
        processor.handleEvent(payload as WorkspaceChatEvent);
        return emitInitMessage();
      }

      // Stream start: mark as active and emit initial partial message
      if (type === "stream-start") {
        processor.handleEvent(payload as WorkspaceChatEvent);
        const messageId = (payload as { messageId: string }).messageId;
        activeStreams.add(messageId);
        return emitPartialMessages(messageId);
      }
      
      // Stream delta: emit partial message with accumulated content
      if (type === "stream-delta") {
        processor.handleEvent(payload as WorkspaceChatEvent);
        const messageId = (payload as { messageId: string }).messageId;
        return emitPartialMessages(messageId);
      }
      
      // Reasoning delta: emit partial reasoning message
      if (type === "reasoning-delta") {
        processor.handleEvent(payload as WorkspaceChatEvent);
        const messageId = (payload as { messageId: string }).messageId;
        return emitPartialMessages(messageId);
      }
      
      // Tool call events: emit partial messages to show tool progress
      if (type === "tool-call-start" || type === "tool-call-delta" || type === "tool-call-end") {
        processor.handleEvent(payload as WorkspaceChatEvent);
        const messageId = (payload as { messageId: string }).messageId;
        return emitPartialMessages(messageId);
      }
      
      // Reasoning end: just process, next delta will emit
      if (type === "reasoning-end") {
        processor.handleEvent(payload as WorkspaceChatEvent);
        return [];
      }

      // Stream end: emit final complete message and clear streaming state
      if (type === "stream-end") {
        processor.handleEvent(payload as WorkspaceChatEvent);
        const messageId = (payload as { messageId: string }).messageId;
        activeStreams.delete(messageId);
        
        const message = processor.getMessageById(messageId);
        if (message) {
          const displayed = transformCmuxToDisplayed(message);
          // Mark as complete (not streaming)
          displayed.forEach((msg) => {
            if ('isStreaming' in msg) {
              (msg as any).isStreaming = false;
            }
            if ('isPartial' in msg) {
              (msg as any).isPartial = false;
            }
          });
          return displayed;
        }
        return [];
      }
      
      // Stream abort: emit partial message marked as interrupted
      if (type === "stream-abort") {
        processor.handleEvent(payload as WorkspaceChatEvent);
        const messageId = (payload as { messageId: string }).messageId;
        activeStreams.delete(messageId);
        return emitPartialMessages(messageId);
      }

      // Pass through certain event types unchanged
      if (PASS_THROUGH_TYPES.has(type)) {
        return [payload as WorkspaceChatEvent];
      }

      // Log unsupported types once
      if (!unsupportedTypesLogged.has(type)) {
        console.warn(`Unhandled workspace chat event type: ${type}`, payload);
        unsupportedTypesLogged.add(type);
      }

      return [
        {
          type: "status",
          status: `Unsupported chat event: ${type}`,
        } as WorkspaceChatEvent,
      ];
    }

    return [];
  };

  const expand = (event: IncomingEvent | IncomingEvent[]): WorkspaceChatEvent[] => {
    if (Array.isArray(event)) {
      return event.flatMap((item) => expandSingle(item));
    }
    return expandSingle(event);
  };

  return { expand };
}

export type { ChatEventExpander };
