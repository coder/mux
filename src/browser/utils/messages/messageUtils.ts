import type { DisplayedMessage } from "@/common/types/message";
import type { BashOutputToolArgs } from "@/common/types/tools";

/**
 * Type guard to check if a message is a bash_output tool call
 */
function isBashOutputTool(
  msg: DisplayedMessage
): msg is DisplayedMessage & { type: "tool"; toolName: "bash_output"; args: BashOutputToolArgs } {
  return msg.type === "tool" && msg.toolName === "bash_output";
}

/**
 * Information about a group of bash_output calls to the same process
 */
export interface BashOutputGroupInfo {
  /** Position in the group: 'first', 'last', or 'middle' (collapsed) */
  position: "first" | "last" | "middle";
  /** Total number of calls in this group */
  totalCount: number;
  /** Number of collapsed (hidden) calls between first and last */
  collapsedCount: number;
  /** Unique group identifier (for React keys) */
  groupId: string;
}

/**
 * Extended DisplayedMessage with optional bash_output grouping info
 */
export type GroupedDisplayedMessage = DisplayedMessage & {
  bashOutputGroup?: BashOutputGroupInfo;
};

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

/**
 * Groups consecutive bash_output tool calls to the same process_id.
 * When 3+ consecutive calls target the same process:
 * - Shows first call with group info (position: 'first')
 * - Shows collapsed indicator (position: 'middle') representing hidden calls
 * - Shows last call with group info (position: 'last')
 *
 * Groups of 1-2 calls are unchanged (no grouping applied).
 *
 * @param messages - Array of DisplayedMessages (already processed by mergeConsecutiveStreamErrors)
 * @returns Array with bash_output groups collapsed, preserving first/last calls
 */
export function groupConsecutiveBashOutput(
  messages: DisplayedMessage[]
): GroupedDisplayedMessage[] {
  if (messages.length === 0) return [];

  const result: GroupedDisplayedMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    // If not a bash_output tool, pass through unchanged
    if (!isBashOutputTool(msg)) {
      result.push(msg);
      i++;
      continue;
    }

    // Find all consecutive bash_output calls with the same process_id
    const processId = msg.args.process_id;
    const groupStart = i;
    let j = i + 1;

    while (j < messages.length) {
      const nextMsg = messages[j];
      if (isBashOutputTool(nextMsg) && nextMsg.args.process_id === processId) {
        j++;
      } else {
        break;
      }
    }

    const groupSize = j - groupStart;
    const groupId = `bash-output-group-${msg.id}`;

    if (groupSize < 3) {
      // Small groups (1-2 items) - no collapsing needed
      for (let k = groupStart; k < j; k++) {
        result.push(messages[k]);
      }
    } else {
      // Large groups (3+) - collapse middle items
      const collapsedCount = groupSize - 2;

      // First item
      result.push({
        ...messages[groupStart],
        bashOutputGroup: {
          position: "first",
          totalCount: groupSize,
          collapsedCount,
          groupId,
        },
      });

      // Collapsed middle indicator (uses first middle message as base)
      result.push({
        ...messages[groupStart + 1],
        id: `${messages[groupStart + 1].id}-collapsed`,
        bashOutputGroup: {
          position: "middle",
          totalCount: groupSize,
          collapsedCount,
          groupId,
        },
      });

      // Last item
      result.push({
        ...messages[j - 1],
        bashOutputGroup: {
          position: "last",
          totalCount: groupSize,
          collapsedCount,
          groupId,
        },
      });
    }

    i = j;
  }

  return result;
}
