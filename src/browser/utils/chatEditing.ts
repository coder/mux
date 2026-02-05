import type { FilePart } from "@/common/orpc/types";
import type {
  CompactionFollowUpRequest,
  DisplayedUserMessage,
  QueuedMessage,
  ReviewNoteDataForDisplay,
} from "@/common/types/message";
import { getEditableUserMessageText } from "@/browser/utils/messages/messageUtils";

// Keep pending edit data normalized with required arrays so edits can't drop attachments/reviews.
export interface PendingUserMessage extends Omit<QueuedMessage, "id" | "hasCompactionRequest"> {
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

export const buildPendingFromDisplayed = (message: DisplayedUserMessage): PendingUserMessage => ({
  content: getEditableUserMessageText(message),
  fileParts: message.fileParts ?? [],
  reviews: message.reviews ?? [],
});

export const buildPendingFromContent = (content: string): PendingUserMessage => ({
  content,
  fileParts: [],
  reviews: [],
});

export const buildEditingStateFromDisplayed = (
  message: DisplayedUserMessage
): EditingMessageState => ({
  id: message.historyId,
  pending: buildPendingFromDisplayed(message),
});

export const buildEditingStateFromContent = (
  messageId: string,
  content: string
): EditingMessageState => ({
  id: messageId,
  pending: buildPendingFromContent(content),
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
