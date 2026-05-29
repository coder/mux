import type { DisplayedMessage } from "@/common/types/message";

export interface PromptHistoryEntry {
  historyId: string;
  content: string;
  historySequence: number;
  timestamp?: number;
  commandPrefix?: string;
  isSideQuestion: boolean;
  fileCount: number;
  fileParts?: Extract<DisplayedMessage, { type: "user" }>["fileParts"];
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
      return message.content.trim().length > 0 || (message.fileParts?.length ?? 0) > 0;
    })
    .map((message) => {
      const fileParts = message.fileParts ?? [];
      return {
        historyId: message.historyId,
        content: message.content,
        historySequence: message.historySequence,
        timestamp: message.timestamp,
        commandPrefix: message.commandPrefix,
        isSideQuestion: message.isSideQuestion === true,
        fileCount: fileParts.length,
        ...(fileParts.length > 0 ? { fileParts } : {}),
      };
    })
    .sort((left, right) => left.historySequence - right.historySequence);
}
