import type { DisplayedMessage } from "@/common/types/message";
import type { BashOutputToolArgs } from "@/common/types/tools";

/**
 * Returns the text that should be placed into the ChatInput when editing a user message.
 */
export function getEditableUserMessageText(
  message: Extract<DisplayedMessage, { type: "user" }>
): string {
  return message.content;
}

/**
 * Type guard to check if a message is a bash_output tool call with valid args
 */
export function isBashOutputTool(
  msg: DisplayedMessage
): msg is DisplayedMessage & { type: "tool"; toolName: "bash_output"; args: BashOutputToolArgs } {
  if (msg.type !== "tool" || msg.toolName !== "bash_output") {
    return false;
  }
  // Validate args has required process_id field
  const args = msg.args;
  return (
    typeof args === "object" &&
    args !== null &&
    "process_id" in args &&
    typeof (args as { process_id: unknown }).process_id === "string"
  );
}

/**
 * Information about a bash_output message's position in a consecutive group.
 * Used at render-time to determine how to display the message.
 */
export interface BashOutputGroupInfo {
  /** Position in the group: 'first', 'last', or 'middle' (collapsed) */
  position: "first" | "last" | "middle";
  /** Total number of calls in this group */
  totalCount: number;
  /** Number of collapsed (hidden) calls between first and last */
  collapsedCount: number;
  /** Process ID for the collapsed indicator */
  processId: string;
  /** Index of the first message in this group (used as expand/collapse key) */
  firstIndex: number;
}

/**
 * Determines if the interrupted barrier should be shown for a DisplayedMessage.
 *
 * The barrier should show when:
 * - Message was interrupted (isPartial) AND not currently streaming
 * - For multi-part messages, only show on the last part
 */
export function shouldShowInterruptedBarrier(msg: DisplayedMessage): boolean {
  if (
    msg.type === "user" ||
    msg.type === "stream-error" ||
    msg.type === "history-hidden" ||
    msg.type === "workspace-init" ||
    msg.type === "plan-display"
  )
    return false;

  // ask_user_question is intentionally a "waiting for input" state. Even if the
  // underlying message is a persisted partial (e.g. after app restart), we keep
  // it answerable instead of showing "Interrupted".
  if (msg.type === "tool" && msg.toolName === "ask_user_question" && msg.status === "executing") {
    return false;
  }

  // Only show on the last part of multi-part messages
  if (!msg.isLastPartOfMessage) return false;

  // Show if interrupted and not actively streaming (tools don't have isStreaming property)
  const isStreaming = "isStreaming" in msg ? msg.isStreaming : false;
  return msg.isPartial && !isStreaming;
}

/**
 * Type guard to check if a message part has a streaming state
 */
export function isStreamingPart(part: unknown): part is { type: "text"; state: "streaming" } {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "text" &&
    "state" in part &&
    part.state === "streaming"
  );
}

/**
 * Merges consecutive stream-error messages with identical content.
 * Returns a new array where consecutive identical errors are represented as a single message
 * with an errorCount field indicating how many times it occurred.
 *
 * @param messages - Array of DisplayedMessages to process
 * @returns Array with consecutive identical errors merged (errorCount added to stream-error variants)
 */
export function mergeConsecutiveStreamErrors(messages: DisplayedMessage[]): DisplayedMessage[] {
  if (messages.length === 0) return [];

  const result: DisplayedMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    // If it's not a stream-error, just add it and move on
    if (msg.type !== "stream-error") {
      result.push(msg);
      i++;
      continue;
    }

    // Count consecutive identical errors
    let count = 1;
    let j = i + 1;
    while (j < messages.length) {
      const nextMsg = messages[j];
      if (
        nextMsg.type === "stream-error" &&
        nextMsg.error === msg.error &&
        nextMsg.errorType === msg.errorType
      ) {
        count++;
        j++;
      } else {
        break;
      }
    }

    // Add the error with count
    result.push({
      ...msg,
      errorCount: count,
    });

    // Skip all the merged errors
    i = j;
  }

  return result;
}

/**
 * Computes the bash_output group info for a message at a given index.
 * Used at render-time to determine how to display bash_output messages.
 *
 * Returns:
 * - undefined if not a bash_output tool or group size < 3
 * - { position: 'first', ... } for the first item in a 3+ group
 * - { position: 'middle', ... } for middle items that should be collapsed
 * - { position: 'last', ... } for the last item in a 3+ group
 *
 * @param messages - The full array of DisplayedMessages
 * @param index - The index of the message to check
 * @returns Group info if in a 3+ group, undefined otherwise
 */
export function computeBashOutputGroupInfo(
  messages: DisplayedMessage[],
  index: number
): BashOutputGroupInfo | undefined {
  const msg = messages[index];

  // Not a bash_output tool
  if (!isBashOutputTool(msg)) {
    return undefined;
  }

  const processId = msg.args.process_id;

  // Find the start of the consecutive group (walk backwards)
  let groupStart = index;
  while (groupStart > 0) {
    const prevMsg = messages[groupStart - 1];
    if (isBashOutputTool(prevMsg) && prevMsg.args.process_id === processId) {
      groupStart--;
    } else {
      break;
    }
  }

  // Find the end of the consecutive group (walk forwards)
  let groupEnd = index;
  while (groupEnd < messages.length - 1) {
    const nextMsg = messages[groupEnd + 1];
    if (isBashOutputTool(nextMsg) && nextMsg.args.process_id === processId) {
      groupEnd++;
    } else {
      break;
    }
  }

  const groupSize = groupEnd - groupStart + 1;

  // Groups of 1-2 don't need special handling
  if (groupSize < 3) {
    return undefined;
  }

  const collapsedCount = groupSize - 2;

  // Determine position
  if (index === groupStart) {
    return {
      position: "first",
      totalCount: groupSize,
      collapsedCount,
      processId,
      firstIndex: groupStart,
    };
  } else if (index === groupEnd) {
    return {
      position: "last",
      totalCount: groupSize,
      collapsedCount,
      processId,
      firstIndex: groupStart,
    };
  } else {
    return {
      position: "middle",
      totalCount: groupSize,
      collapsedCount,
      processId,
      firstIndex: groupStart,
    };
  }
}
