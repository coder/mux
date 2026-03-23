import type { DisplayedMessage } from "@/common/types/message";
import { formatReviewForModel } from "@/common/types/review";
import type { BashOutputToolArgs } from "@/common/types/tools";
import {
  getLastNonDecorativeMessage,
  hasExecutingAskUserQuestionInLatestTurn,
} from "@/common/utils/messages/retryEligibility";

/**
 * Returns the text that should be placed into the ChatInput when editing a user message.
 */
export function getEditableUserMessageText(
  message: Extract<DisplayedMessage, { type: "user" }>
): string {
  const reviews = message.reviews;
  if (!reviews || reviews.length === 0) {
    return message.content;
  }

  // Reviews are already stored in metadata; strip their rendered tags to avoid duplication on edit.
  const reviewText = reviews.map(formatReviewForModel).join("\n\n");
  if (!message.content.startsWith(reviewText)) {
    return message.content;
  }

  const remainder = message.content.slice(reviewText.length);
  if (remainder.startsWith("\n\n")) {
    return remainder.slice(2);
  }
  if (remainder.startsWith("\n")) {
    return remainder.slice(1);
  }
  return remainder;
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
export function shouldShowInterruptedBarrier(
  msg: DisplayedMessage,
  allMessages: DisplayedMessage[] = [msg],
  awaitingUserQuestion = false
): boolean {
  if (
    msg.type === "user" ||
    msg.type === "stream-error" ||
    msg.type === "compaction-boundary" ||
    msg.type === "history-hidden" ||
    msg.type === "workspace-init" ||
    msg.type === "plan-display"
  )
    return false;

  const lastMessage = (() => {
    const latest = getLastNonDecorativeMessage(allMessages);
    if (latest?.type !== "plan-display") {
      return latest;
    }

    // /plan previews are ephemeral transcript rows and should not redefine the
    // latest actionable assistant turn for interruption UI.
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const candidate = allMessages[i];
      if (
        candidate.type === "plan-display" ||
        candidate.type === "history-hidden" ||
        candidate.type === "workspace-init" ||
        candidate.type === "compaction-boundary"
      ) {
        continue;
      }
      return candidate;
    }

    return undefined;
  })();

  const isLatestTurnRow =
    lastMessage != null &&
    "historyId" in msg &&
    "historyId" in lastMessage &&
    msg.historyId === lastMessage.historyId;

  // ask_user_question is intentionally a "waiting for input" state. Even if the
  // question row is truncated in the displayed transcript, the authoritative
  // awaitingUserQuestion workspace state should still suppress interrupted UI for
  // the latest turn.
  if (isLatestTurnRow && awaitingUserQuestion) {
    return false;
  }

  // Fallback for callers that don't provide the authoritative awaiting flag:
  // infer from displayed rows only.
  if (isLatestTurnRow && hasExecutingAskUserQuestionInLatestTurn(allMessages)) {
    return false;
  }

  // Keep executing ask_user_question rows free of interruption markers even when
  // the same turn has a trailing stream-error row; those questions remain
  // answerable and should not show contradictory "interrupted" affordances.
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
 * Returns whether ChatPane should bypass useDeferredValue and render the immediate
 * message list. We bypass deferral while assistant content is streaming OR while
 * any tool call is still executing (e.g. live bash output).
 *
 * We also bypass when the deferred snapshot appears stale (it still has active
 * streaming/executing rows after the immediate snapshot is idle), or when both
 * snapshots have diverged in row identity/order. Showing stale deferred rows can
 * cause hidden-marker placement and tool-state flash at stream completion.
 */
export function shouldBypassDeferredMessages(
  messages: DisplayedMessage[],
  deferredMessages: DisplayedMessage[]
): boolean {
  const hasActiveRows = (rows: DisplayedMessage[]) =>
    rows.some(
      (m) =>
        ("isStreaming" in m && m.isStreaming) || (m.type === "tool" && m.status === "executing")
    );

  if (messages.length !== deferredMessages.length) {
    return true;
  }

  for (let i = 0; i < messages.length; i++) {
    const immediateMessage = messages[i];
    const deferredMessage = deferredMessages[i];
    if (!immediateMessage || !deferredMessage) {
      return true;
    }

    if (
      immediateMessage.id !== deferredMessage.id ||
      immediateMessage.type !== deferredMessage.type
    ) {
      return true;
    }
  }

  return hasActiveRows(messages) || hasActiveRows(deferredMessages);
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
 * Precompute bash_output grouping metadata for all rows in one linear pass.
 *
 * Why: workspace-open now renders full history in a single commit. Doing a backward+forward
 * scan per row turns long transcripts into O(n²) grouping work right on the critical path.
 */
export function computeBashOutputGroupInfos(
  messages: DisplayedMessage[]
): Array<BashOutputGroupInfo | undefined> {
  const groupInfos = new Array<BashOutputGroupInfo | undefined>(messages.length);

  let index = 0;
  while (index < messages.length) {
    const msg = messages[index];
    if (!isBashOutputTool(msg)) {
      index++;
      continue;
    }

    const processId = msg.args.process_id;
    let groupEnd = index;

    while (groupEnd < messages.length - 1) {
      const nextMsg = messages[groupEnd + 1];
      if (!isBashOutputTool(nextMsg) || nextMsg.args.process_id !== processId) {
        break;
      }
      groupEnd++;
    }

    const groupSize = groupEnd - index + 1;
    if (groupSize >= 3) {
      const collapsedCount = groupSize - 2;

      for (let groupIndex = index; groupIndex <= groupEnd; groupIndex++) {
        let position: BashOutputGroupInfo["position"] = "middle";
        if (groupIndex === index) {
          position = "first";
        } else if (groupIndex === groupEnd) {
          position = "last";
        }

        groupInfos[groupIndex] = {
          position,
          totalCount: groupSize,
          collapsedCount,
          processId,
          firstIndex: index,
        };
      }
    }

    index = groupEnd + 1;
  }

  return groupInfos;
}

/**
 * Computes the bash_output group info for a message at a given index.
 */
export function computeBashOutputGroupInfo(
  messages: DisplayedMessage[],
  index: number
): BashOutputGroupInfo | undefined {
  if (index < 0 || index >= messages.length) {
    return undefined;
  }

  return computeBashOutputGroupInfos(messages)[index];
}
