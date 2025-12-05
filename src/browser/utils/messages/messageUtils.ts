import type { DisplayedMessage } from "@/common/types/message";

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
