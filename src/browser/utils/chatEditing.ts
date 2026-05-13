import type { FilePart } from "@/common/orpc/types";
import type {
  CompactionFollowUpRequest,
  DisplayedUserMessage,
  QueuedMessage,
  ReviewNoteDataForDisplay,
} from "@/common/types/message";
import { getEditableUserMessageText } from "@/browser/utils/messages/messageUtils";
import { stripMonitorWakeXml } from "@/common/utils/monitorWake";

// Keep pending edit data normalized with required arrays so edits can't drop attachments/reviews.
export interface PendingUserMessage extends Omit<
  QueuedMessage,
  "id" | "hasCompactionRequest" | "queueDispatchMode"
> {
  fileParts: FilePart[];
  reviews: ReviewNoteDataForDisplay[];
}

export interface EditingMessageState {
  id: string;
  pending: PendingUserMessage;
}

export const normalizeQueuedMessage = (queued: QueuedMessage): PendingUserMessage => ({
  // Strip backend-generated monitor wake XML so the Edit composer never loads the synthetic
  // `<monitor-event …>` payload as if the user had typed it. We can be unconditional here:
  // the helper is a no-op when no monitor blocks are present.
  content:
    queued.containsMonitorEvents === true ? stripMonitorWakeXml(queued.content) : queued.content,
  fileParts: queued.fileParts ?? [],
  reviews: queued.reviews ?? [],
});

/**
 * Returns true when a queued message is *only* a backend-generated monitor wake — i.e. the
 * synthetic `<monitor-event source="mux" …>` XML with no surviving user-authored text or
 * attachments. Edit/restore-to-input paths must skip these queues so we never clear the
 * backend queue and drop the wake into an empty composer (the wake would silently never
 * reach the agent). Callers should instead fall through to the previous-message edit path.
 */
export const isPureMonitorWakeQueue = (queued: QueuedMessage): boolean => {
  if (queued.containsMonitorEvents !== true) return false;
  const remainingText = stripMonitorWakeXml(queued.content);
  if (remainingText.length > 0) return false;
  if ((queued.fileParts?.length ?? 0) > 0) return false;
  if ((queued.reviews?.length ?? 0) > 0) return false;
  return true;
};

const LOCAL_COMMAND_STDOUT_OPEN_TAG = "<local-command-stdout>";
const LOCAL_COMMAND_STDOUT_CLOSE_TAG = "</local-command-stdout>";

export const canEditDisplayedUserMessage = (message: DisplayedUserMessage): boolean => {
  if (message.isGoalContinuation === true || message.isBudgetLimitWrapup === true) return false;
  if (message.content.startsWith(LOCAL_COMMAND_STDOUT_OPEN_TAG)) {
    return !message.content.endsWith(LOCAL_COMMAND_STDOUT_CLOSE_TAG);
  }
  return true;
};

export const buildPendingFromDisplayed = (message: DisplayedUserMessage): PendingUserMessage => ({
  content: getEditableUserMessageText(message),
  fileParts: message.fileParts ?? [],
  reviews: message.reviews ?? [],
});

export const buildEditingStateFromDisplayed = (
  message: DisplayedUserMessage
): EditingMessageState => ({
  id: message.historyId,
  pending: buildPendingFromDisplayed(message),
});

/**
 * Build editing state from a compaction command and its follow-up content.
 * Preserves file attachments and reviews that would be sent after compaction completes.
 */
export const buildEditingStateFromCompaction = (
  messageId: string,
  command: string,
  followUp?: CompactionFollowUpRequest
): EditingMessageState => ({
  id: messageId,
  pending: {
    content: command,
    fileParts: followUp?.fileParts ?? [],
    reviews: followUp?.reviews ?? [],
  },
});
