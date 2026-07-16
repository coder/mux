import type { FilePart } from "@/common/orpc/types";
import type {
  ChatAttachment,
  StagedChatAttachment,
} from "@/browser/features/ChatInput/ChatAttachments";
import {
  displayStagedAttachmentsToChatAttachments,
  parseStagedAttachmentNotice,
} from "@/browser/features/ChatInput/stagedAttachments";
import type {
  CompactionFollowUpRequest,
  DisplayedUserMessage,
  MuxMessageMetadata,
  QueuedMessage,
  ReviewNoteDataForDisplay,
} from "@/common/types/message";
import type { Review } from "@/common/types/review";
import { getEditableUserMessageDraftContent } from "@/browser/utils/messages/messageUtils";

// Keep pending edit data normalized with required arrays so edits can't drop attachments/reviews.
export interface PendingUserMessage extends Omit<
  QueuedMessage,
  "id" | "hasCompactionRequest" | "queueDispatchMode"
> {
  fileParts: FilePart[];
  stagedAttachments: StagedChatAttachment[];
  reviews: ReviewNoteDataForDisplay[];
  muxMetadata?: MuxMessageMetadata;
}

export interface EditingMessageState {
  id: string;
  pending: PendingUserMessage;
  /**
   * Sending this edit will truncate across the latest context boundary, so the
   * composer must confirm before discarding the compaction/reset summary.
   */
  isBeforeLatestContextBoundary?: boolean;
}

function stagedAttachmentsFromText(
  text: string | undefined,
  idPrefix: string
): StagedChatAttachment[] {
  if (!text) {
    return [];
  }
  const parsed = parseStagedAttachmentNotice(text);
  return displayStagedAttachmentsToChatAttachments(parsed.attachments, idPrefix);
}

export const normalizeQueuedMessage = (queued: QueuedMessage): PendingUserMessage =>
  buildPendingFromRestoredInput({
    content: queued.content,
    fileParts: queued.fileParts ?? [],
    reviews: queued.reviews ?? [],
    idPrefix: `queued-${queued.id}`,
  });

export function buildPendingFromRestoredInput(params: {
  content: string;
  fileParts: FilePart[];
  reviews: ReviewNoteDataForDisplay[];
  idPrefix: string;
  muxMetadata?: MuxMessageMetadata;
}): PendingUserMessage {
  const parsed = parseStagedAttachmentNotice(params.content);
  return {
    content: parsed.text,
    fileParts: params.fileParts,
    stagedAttachments: displayStagedAttachmentsToChatAttachments(
      parsed.attachments,
      params.idPrefix
    ),
    reviews: params.reviews,
    muxMetadata: params.muxMetadata,
  };
}

export function hasRestoredDraftReplacementPayload(params: {
  fileParts?: FilePart[];
  reviews?: ReviewNoteDataForDisplay[];
  muxMetadata?: MuxMessageMetadata;
  stagedAttachments: readonly StagedChatAttachment[];
}): boolean {
  return (
    params.fileParts !== undefined ||
    params.reviews !== undefined ||
    params.muxMetadata !== undefined ||
    params.stagedAttachments.length > 0
  );
}

export interface RestoredDraftPayload {
  text: string;
  attachments: ChatAttachment[];
  reviews?: ReviewNoteDataForDisplay[];
}

export function getRestoredDraftPayloadSignature(payload: RestoredDraftPayload): string {
  return JSON.stringify({
    text: payload.text,
    attachments: payload.attachments.map((attachment) =>
      attachment.kind === "staged"
        ? {
            kind: attachment.kind,
            id: attachment.id,
            filename: attachment.filename,
            mediaType: attachment.mediaType,
            sizeBytes: attachment.sizeBytes,
            stagedPath: attachment.stagedPath,
          }
        : {
            kind: attachment.kind,
            id: attachment.id,
            filename: attachment.filename,
            mediaType: attachment.mediaType,
            resizeInfo: attachment.resizeInfo,
            url: attachment.url,
          }
    ),
    reviews: (payload.reviews ?? []).map((review) => ({
      filePath: review.filePath,
      lineRange: review.lineRange,
      newStart: review.newStart,
      oldStart: review.oldStart,
      selectedCode: review.selectedCode,
      selectedDiff: review.selectedDiff,
      userNote: review.userNote,
    })),
  });
}

export function getRestoredMuxMetadataForCurrentDraft(params: {
  currentDraft: RestoredDraftPayload;
  sourceSignature: string | null;
  muxMetadata?: MuxMessageMetadata;
}): MuxMessageMetadata | undefined {
  if (!params.muxMetadata || params.sourceSignature === null) {
    return undefined;
  }
  return getRestoredDraftPayloadSignature(params.currentDraft) === params.sourceSignature
    ? params.muxMetadata
    : undefined;
}

export function getReviewNoteSignature(review: ReviewNoteDataForDisplay): string {
  return JSON.stringify({
    filePath: review.filePath,
    lineRange: review.lineRange,
    newStart: review.newStart,
    oldStart: review.oldStart,
    selectedCode: review.selectedCode,
    selectedDiff: review.selectedDiff,
    userNote: review.userNote,
  });
}

export function mergeNewAttachedReviewsIntoDraft(params: {
  draftReviews: ReviewNoteDataForDisplay[];
  attachedReviews: Review[];
  mergedAttachedReviewIds: ReadonlySet<string>;
}): {
  reviews: ReviewNoteDataForDisplay[];
  mergedAttachedReviewIds: Set<string>;
  mergedReviewIds: string[];
} {
  const mergedAttachedReviewIds = new Set(params.mergedAttachedReviewIds);
  const existingReviewSignatures = new Set(params.draftReviews.map(getReviewNoteSignature));
  const additions: ReviewNoteDataForDisplay[] = [];
  const mergedReviewIds: string[] = [];

  for (const review of params.attachedReviews) {
    if (mergedAttachedReviewIds.has(review.id)) {
      continue;
    }

    mergedAttachedReviewIds.add(review.id);
    const signature = getReviewNoteSignature(review.data);
    if (existingReviewSignatures.has(signature)) {
      mergedReviewIds.push(review.id);
      continue;
    }

    existingReviewSignatures.add(signature);
    additions.push(review.data);
    mergedReviewIds.push(review.id);
  }

  return {
    reviews: additions.length > 0 ? [...params.draftReviews, ...additions] : params.draftReviews,
    mergedAttachedReviewIds,
    mergedReviewIds,
  };
}

export function releaseDraftReviewMergeTracking(params: {
  draftReviewId: string;
  checkIdsByDraftId: Map<string, Set<string>>;
  mergedAttachedReviewIds: Set<string> | null;
}): void {
  const attachedReviewIds = params.checkIdsByDraftId.get(params.draftReviewId);
  params.checkIdsByDraftId.delete(params.draftReviewId);

  for (const attachedReviewId of attachedReviewIds ?? []) {
    params.mergedAttachedReviewIds?.delete(attachedReviewId);
  }
}

const LOCAL_COMMAND_STDOUT_OPEN_TAG = "<local-command-stdout>";
const LOCAL_COMMAND_STDOUT_CLOSE_TAG = "</local-command-stdout>";

export const canEditDisplayedUserMessage = (message: DisplayedUserMessage): boolean => {
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

export const buildPendingFromDisplayed = (message: DisplayedUserMessage): PendingUserMessage => {
  const draft = getEditableUserMessageDraftContent(message);
  return {
    content: draft.text,
    fileParts: message.fileParts ?? [],
    stagedAttachments: draft.stagedAttachments,
    reviews: message.reviews ?? [],
  };
};

export const buildEditingStateFromDisplayed = (
  message: DisplayedUserMessage
): EditingMessageState => ({
  id: message.historyId,
  pending: buildPendingFromDisplayed(message),
  ...(message.isBeforeLatestContextBoundary === true
    ? { isBeforeLatestContextBoundary: true }
    : {}),
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
    stagedAttachments: stagedAttachmentsFromText(followUp?.text, `compaction-${messageId}`),
    reviews: followUp?.reviews ?? [],
    muxMetadata: followUp?.muxMetadata,
  },
});
