import type { DisplayedMessage } from "@/common/types/message";
import { getEditableUserMessageText } from "@/browser/utils/messages/messageUtils";

type UserMessage = Extract<DisplayedMessage, { type: "user" }>;
const LOCAL_COMMAND_STDOUT_OPEN_TAG = "<local-command-stdout>";
const LOCAL_COMMAND_STDOUT_CLOSE_TAG = "</local-command-stdout>";

export interface PromptHistoryEntry {
  historyId: string;
  content: string;
  historySequence: number;
  timestamp?: number;
  commandPrefix?: string;
  isSideQuestion: boolean;
  fileCount: number;
  fileParts?: UserMessage["fileParts"];
  reviews?: UserMessage["reviews"];
}

function isCompletedLocalCommandOutput(message: UserMessage): boolean {
  return (
    message.content.startsWith(LOCAL_COMMAND_STDOUT_OPEN_TAG) &&
    message.content.endsWith(LOCAL_COMMAND_STDOUT_CLOSE_TAG)
  );
}

export function getPromptHistoryEntries(
  messages: readonly DisplayedMessage[]
): PromptHistoryEntry[] {
  return messages
    .filter((message): message is Extract<DisplayedMessage, { type: "user" }> => {
      if (message.type !== "user") {
        return false;
      }
      if (message.isSynthetic || message.isGoalContinuation || message.isBudgetLimitWrapup) {
        return false;
      }
      if (isCompletedLocalCommandOutput(message)) {
        return false;
      }
      return message.content.trim().length > 0 || (message.fileParts?.length ?? 0) > 0;
    })
    .map((message) => {
      const followUpContent = message.compactionRequest?.parsed.followUpContent;
      const fileParts = followUpContent?.fileParts ?? message.fileParts ?? [];
      const reviews = followUpContent?.reviews ?? message.reviews ?? [];
      const content = getEditableUserMessageText(message);
      return {
        historyId: message.historyId,
        content,
        historySequence: message.historySequence,
        timestamp: message.timestamp,
        commandPrefix: message.commandPrefix,
        isSideQuestion: message.isSideQuestion === true,
        fileCount: fileParts.length,
        ...(fileParts.length > 0 ? { fileParts } : {}),
        ...(reviews.length > 0 ? { reviews } : {}),
      };
    })
    .sort((left, right) => left.historySequence - right.historySequence);
}
