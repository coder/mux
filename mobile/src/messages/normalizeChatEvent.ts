import type { DisplayedMessage, WorkspaceChatEvent } from "../types";
import type { MuxMessage, MuxTextPart, MuxFilePart } from "@/common/types/message";
import type { DynamicToolPart } from "@/common/types/toolParts";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { isMuxMessage } from "@/common/orpc/types";
import { createChatEventProcessor } from "@/browser/utils/messages/ChatEventProcessor";

/**
 * All possible event types that have a `type` discriminant field.
 * This is derived from WorkspaceChatMessage excluding MuxMessage (which uses `role`).
 *
 * IMPORTANT: When adding new event types to the schema, TypeScript will error
 * here if the handler map doesn't handle them - preventing runtime surprises.
 */
type TypedEventType =
  Exclude<WorkspaceChatMessage, MuxMessage> extends infer T
    ? T extends { type: infer U }
      ? U
      : never
    : never;

type IncomingEvent = WorkspaceChatEvent | DisplayedMessage | string | number | null | undefined;

export interface ChatEventExpander {
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
  "plan-display",
]);

const DEBUG_TAG = "[ChatEventExpander]";

const INIT_MESSAGE_ID = "workspace-init";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
 * Transform MuxMessage into DisplayedMessage array.
 * Handles merging adjacent text/reasoning parts and extracting tool calls.
 */
function transformMuxToDisplayed(message: MuxMessage): DisplayedMessage[] {
  const displayed: DisplayedMessage[] = [];
  const historySequence = message.metadata?.historySequence ?? 0;
  const baseTimestamp = message.metadata?.timestamp;
  let streamSeq = 0;

  if (message.role === "user") {
    const content = message.parts
      .filter((p): p is MuxTextPart => p.type === "text")
      .map((p) => p.text)
      .join("");

    const fileParts = message.parts
      .filter((p): p is MuxFilePart => p.type === "file")
      .map((p) => ({
        url: p.url,
        mediaType: p.mediaType,
        filename: p.filename,
      }));

    displayed.push({
      type: "user",
      id: message.id,
      historyId: message.id,
      content,
      fileParts: fileParts.length > 0 ? fileParts : undefined,
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
          // Support both new enum ("user"|"idle") and legacy boolean (true)
          isCompacted: !!message.metadata?.compacted,
          isIdleCompacted: message.metadata?.compacted === "idle",
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
        durationMs: initState.durationMs,
      },
    ];
  };

  /**
   * Emit partial messages for active stream.
   * Called during streaming to show real-time updates.
   */
  const emitDisplayedMessages = (
    messageId: string,
    options: { isStreaming: boolean }
  ): DisplayedMessage[] => {
    const message = processor.getMessageById(messageId);
    if (!message) {
      return [];
    }

    const displayed = transformMuxToDisplayed(message);

    return displayed.map((msg, index) => {
      const isLastPartOfMessage = index === displayed.length - 1;

      if (msg.type === "assistant" || msg.type === "reasoning") {
        msg.isStreaming = options.isStreaming;
        msg.isPartial = options.isStreaming;
        msg.isLastPartOfMessage = isLastPartOfMessage;
        return msg;
      }

      if (msg.type === "tool") {
        msg.isPartial = options.isStreaming;
        msg.isLastPartOfMessage = isLastPartOfMessage;

        // Fix: Running tools show as "interrupted" because they are partial.
        // If the stream is active, they should be "executing".
        if (msg.status === "interrupted" && options.isStreaming) {
          msg.status = "executing";
        }
        return msg;
      }

      return msg;
    });
  };

  const expandSingle = (payload: IncomingEvent | undefined): WorkspaceChatEvent[] => {
    if (!payload) {
      return [];
    }

    if (Array.isArray(payload)) {
      return payload.flatMap((item) => expandSingle(item));
    }

    if (isObject(payload)) {
      const candidate = payload as WorkspaceChatMessage;
      if (isMuxMessage(candidate)) {
        const muxMessage: MuxMessage = candidate;
        const historySequence = muxMessage.metadata?.historySequence;

        if (typeof historySequence !== "number" || !Number.isFinite(historySequence)) {
          console.warn(`${DEBUG_TAG} Dropping mux message without historySequence`, {
            id: muxMessage.id,
            role: muxMessage.role,
            metadata: muxMessage.metadata,
          });
          return [];
        }

        processor.handleEvent(muxMessage as WorkspaceChatMessage);
        const displayed = transformMuxToDisplayed(muxMessage);

        if (displayed.length === 0) {
          return [];
        }

        return displayed;
      }
    }
    if (typeof payload === "string" || typeof payload === "number") {
      // Skip primitive values - they're not valid events
      console.warn("Received non-object payload, skipping:", payload);
      return [];
    }

    if (isObject(payload) && typeof payload.type === "string") {
      // Check if it's an already-formed DisplayedMessage (from backend)
      if (
        "historySequence" in payload &&
        DISPLAYABLE_MESSAGE_TYPES.has(payload.type as DisplayedMessage["type"])
      ) {
        return [payload as DisplayedMessage];
      }

      const type = payload.type as TypedEventType;
      // Cast once - we've verified payload is an object with a type field
      const event = payload as Record<string, unknown>;
      const getMessageId = () => (typeof event.messageId === "string" ? event.messageId : "");

      // Handler map for all typed events - TypeScript enforces exhaustiveness
      // If a new event type is added to the schema, this will error until handled
      const handlers: Record<TypedEventType, () => WorkspaceChatEvent[]> = {
        // Init events: emit workspace init message
        "init-start": () => {
          processor.handleEvent(payload as unknown as WorkspaceChatMessage);
          return emitInitMessage();
        },
        "init-output": () => {
          processor.handleEvent(payload as unknown as WorkspaceChatMessage);
          return emitInitMessage();
        },
        "init-end": () => {
          processor.handleEvent(payload as unknown as WorkspaceChatMessage);
          return emitInitMessage();
        },

        // Stream lifecycle: manage active streams and emit displayed messages
        "stream-start": () => {
          processor.handleEvent(payload as unknown as WorkspaceChatMessage);
          const messageId = getMessageId();
          if (!messageId) return [];
          activeStreams.add(messageId);
          return emitDisplayedMessages(messageId, { isStreaming: true });
        },
        "stream-delta": () => {
          processor.handleEvent(payload as unknown as WorkspaceChatMessage);
          const messageId = getMessageId();
          if (!messageId) return [];
          return emitDisplayedMessages(messageId, { isStreaming: true });
        },
        "stream-end": () => {
          processor.handleEvent(payload as unknown as WorkspaceChatMessage);
          const messageId = getMessageId();
          if (!messageId) return [];
          activeStreams.delete(messageId);
          return emitDisplayedMessages(messageId, { isStreaming: false });
        },
        "stream-abort": () => {
          processor.handleEvent(payload as unknown as WorkspaceChatMessage);
          const messageId = getMessageId();
          if (!messageId) return [];
          activeStreams.delete(messageId);
          return emitDisplayedMessages(messageId, { isStreaming: false });
        },

        // Tool call events: emit partial messages to show tool progress
        "tool-call-start": () => {
          processor.handleEvent(payload as unknown as WorkspaceChatMessage);
          const messageId = getMessageId();
          if (!messageId) return [];
          return emitDisplayedMessages(messageId, { isStreaming: true });
        },
        "tool-call-delta": () => {
          processor.handleEvent(payload as unknown as WorkspaceChatMessage);
          const messageId = getMessageId();
          if (!messageId) return [];
          return emitDisplayedMessages(messageId, { isStreaming: true });
        },
        "tool-call-end": () => {
          processor.handleEvent(payload as unknown as WorkspaceChatMessage);
          const messageId = getMessageId();
          if (!messageId) return [];
          return emitDisplayedMessages(messageId, { isStreaming: true });
        },

        // Reasoning events
        "reasoning-delta": () => {
          processor.handleEvent(payload as unknown as WorkspaceChatMessage);
          const messageId = getMessageId();
          if (!messageId) return [];
          return emitDisplayedMessages(messageId, { isStreaming: true });
        },
        "reasoning-end": () => {
          processor.handleEvent(payload as unknown as WorkspaceChatMessage);
          return [];
        },

        // UI-only incremental output from the bash tool.
        // This is rendered inside the bash tool card (and should not spam the timeline).
        "bash-output": () => [],

        // Rolled-up session usage from deleted child workspaces (desktop-only for now).
        "session-usage-delta": () => [],
        // Usage delta: mobile app doesn't display usage, silently ignore
        "usage-delta": () => [],

        // Compaction/retry status signals: desktop-only affordances for now.
        // Mobile intentionally drops these to avoid noisy "unsupported event" rows.
        "idle-compaction-needed": () => [],
        "idle-compaction-started": () => [],
        "auto-compaction-triggered": () => [],
        "auto-compaction-completed": () => [],
        "auto-retry-scheduled": () => [],
        "auto-retry-starting": () => [],
        "auto-retry-abandoned": () => [],

        // Pass-through events: return unchanged
        "caught-up": () => [payload as WorkspaceChatEvent],
        "stream-error": () => [payload as WorkspaceChatEvent],
        delete: () => [payload as WorkspaceChatEvent],

        // Error event: emit as stream-error for display
        error: (): WorkspaceChatEvent[] => {
          const errorEvent = event as { error?: string; errorType?: string };
          return [
            {
              type: "stream-error",
              error: errorEvent.error ?? "Unknown error",
              errorType: errorEvent.errorType,
            },
          ];
        },

        // Queue/restore events: pass through (mobile may use these later)
        "queued-message-changed": () => [payload as WorkspaceChatEvent],
        "restore-to-input": () => [payload as WorkspaceChatEvent],
      };

      const handler = handlers[type];
      if (handler) {
        return handler();
      }

      // Fallback for truly unknown types (e.g., from newer backend)
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
