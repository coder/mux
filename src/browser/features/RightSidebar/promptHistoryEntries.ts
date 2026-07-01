import {
  type CompactionFollowUpRequest,
  type DisplayedMessage,
  type MuxMessageMetadata,
} from "@/common/types/message";
import {
  appendStagedAttachmentNotice,
  displayStagedAttachmentsToChatAttachments,
  parseStagedAttachmentNotice,
} from "@/browser/features/ChatInput/stagedAttachments";
import { getEditableUserMessageDraftContent } from "@/browser/utils/messages/messageUtils";

type UserMessage = Extract<DisplayedMessage, { type: "user" }>;
const LOCAL_COMMAND_STDOUT_OPEN_TAG = "<local-command-stdout>";
const LOCAL_COMMAND_STDOUT_CLOSE_TAG = "</local-command-stdout>";

export interface PromptHistoryEntry {
  historyId: string;
  content: string;
  insertContent?: string;
  historySequence: number;
  timestamp?: number;
  commandPrefix?: string;
  isSideQuestion: boolean;
  fileCount: number;
  fileParts?: UserMessage["fileParts"];
  reviews?: UserMessage["reviews"];
  muxMetadata?: MuxMessageMetadata;
}

function isCompletedLocalCommandOutput(message: UserMessage): boolean {
  return (
    message.content.startsWith(LOCAL_COMMAND_STDOUT_OPEN_TAG) &&
    message.content.endsWith(LOCAL_COMMAND_STDOUT_CLOSE_TAG)
  );
}

function getMuxMetadataRawCommand(metadata?: MuxMessageMetadata): string | undefined {
  if (!metadata || !("rawCommand" in metadata)) {
    return undefined;
  }

  const { rawCommand } = metadata;
  return rawCommand && rawCommand.trim().length > 0 ? rawCommand : undefined;
}

function buildSyntheticFollowUpEntry(
  message: UserMessage,
  followUpContent?: CompactionFollowUpRequest
): PromptHistoryEntry | null {
  if (!followUpContent || followUpContent.dispatchOptions?.source === "internal-resume") {
    return null;
  }

  const parsed = parseStagedAttachmentNotice(followUpContent.text ?? "");
  const stagedAttachments = displayStagedAttachmentsToChatAttachments(
    parsed.attachments,
    `history-${message.historyId}`
  );
  const fileParts = followUpContent.fileParts ?? [];
  const reviews = followUpContent.reviews ?? [];
  const rawCommand = getMuxMetadataRawCommand(followUpContent.muxMetadata);

  if (
    parsed.text.trim().length === 0 &&
    stagedAttachments.length === 0 &&
    fileParts.length === 0 &&
    reviews.length === 0 &&
    !rawCommand
  ) {
    return null;
  }

  const insertContent =
    rawCommand ??
    (stagedAttachments.length > 0
      ? appendStagedAttachmentNotice(parsed.text, stagedAttachments)
      : parsed.text);

  return {
    historyId: message.historyId,
    content: parsed.text.trim().length > 0 ? parsed.text : (rawCommand ?? parsed.text),
    ...(insertContent !== parsed.text ? { insertContent } : {}),
    historySequence: message.historySequence,
    timestamp: message.timestamp,
    commandPrefix: undefined,
    isSideQuestion: false,
    fileCount: fileParts.length + stagedAttachments.length,
    ...(fileParts.length > 0 ? { fileParts } : {}),
    ...(reviews.length > 0 ? { reviews } : {}),
    ...(followUpContent.muxMetadata ? { muxMetadata: followUpContent.muxMetadata } : {}),
  };
}

export function getPromptHistoryEntries(
  messages: readonly DisplayedMessage[]
): PromptHistoryEntry[] {
  return messages
    .flatMap((message): PromptHistoryEntry[] => {
      if (message.type !== "user") {
        return [];
      }
      if (message.isGoalContinuation || message.isBudgetLimitWrapup) {
        return [];
      }
      if (isCompletedLocalCommandOutput(message)) {
        return [];
      }

      const followUpContent = message.compactionRequest?.parsed.followUpContent;
      if (message.isSynthetic) {
        const entry = buildSyntheticFollowUpEntry(message, followUpContent);
        return entry ? [entry] : [];
      }

      if (message.content.trim().length === 0 && (message.fileParts?.length ?? 0) === 0) {
        return [];
      }

      const fileParts = followUpContent?.fileParts ?? message.fileParts ?? [];
      const reviews = followUpContent?.reviews ?? message.reviews ?? [];
      const draft = getEditableUserMessageDraftContent(message);
      const content = draft.text;
      const insertContent =
        draft.stagedAttachments.length > 0
          ? appendStagedAttachmentNotice(content, draft.stagedAttachments)
          : content;
      return [
        {
          historyId: message.historyId,
          content,
          ...(insertContent !== content ? { insertContent } : {}),
          historySequence: message.historySequence,
          timestamp: message.timestamp,
          commandPrefix: message.commandPrefix,
          isSideQuestion: message.isSideQuestion === true,
          fileCount: fileParts.length + draft.stagedAttachments.length,
          ...(fileParts.length > 0 ? { fileParts } : {}),
          ...(reviews.length > 0 ? { reviews } : {}),
          ...(followUpContent?.muxMetadata ? { muxMetadata: followUpContent.muxMetadata } : {}),
        },
      ];
    })
    .sort((left, right) => left.historySequence - right.historySequence);
}
