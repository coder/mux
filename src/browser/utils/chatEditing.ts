import type { FilePart } from "@/common/orpc/types";
import type {
  CompactionFollowUpRequest,
  DisplayedUserMessage,
  QueuedMessage,
  ReviewNoteDataForDisplay,
} from "@/common/types/message";
import { getEditableUserMessageText } from "@/browser/utils/messages/messageUtils";

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
  content: queued.content,
  fileParts: queued.fileParts ?? [],
  reviews: queued.reviews ?? [],
});

const LOCAL_COMMAND_STDOUT_OPEN_TAG = "<local-command-stdout>";
const LOCAL_COMMAND_STDOUT_CLOSE_TAG = "</local-command-stdout>";

export const canEditDisplayedUserMessage = (message: DisplayedUserMessage): boolean => {
  if (message.isBeforeLatestContextBoundary === true) return false;
  // /btw rows are persisted read-only side branches. Editing one would route the
  // edited text through the normal main-thread send path and truncate history
  // from the aside instead of re-running the side-question flow.
  if (message.isSideQuestion === true) return false;
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
