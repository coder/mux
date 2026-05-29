import { describe, expect, test } from "bun:test";
import type { DisplayedMessage } from "@/common/types/message";
import { getPromptHistoryEntries } from "./promptHistoryEntries";

function userMessage(
  id: string,
  content: string,
  historySequence: number,
  overrides: Partial<Extract<DisplayedMessage, { type: "user" }>> = {}
): Extract<DisplayedMessage, { type: "user" }> {
  return {
    type: "user",
    id,
    historyId: id,
    content,
    historySequence,
    ...overrides,
  };
}

describe("getPromptHistoryEntries", () => {
  test("returns real user prompts sorted from oldest to newest", () => {
    const messages: DisplayedMessage[] = [
      userMessage("newer", "Newer prompt", 3),
      {
        type: "assistant",
        id: "assistant",
        historyId: "assistant",
        content: "Response",
        historySequence: 2,
        isStreaming: false,
        isPartial: false,
        isCompacted: false,
        isIdleCompacted: false,
      },
      userMessage("older", "Older prompt", 1),
    ];

    expect(getPromptHistoryEntries(messages).map((entry) => entry.historyId)).toEqual([
      "older",
      "newer",
    ]);
  });

  test("skips synthetic continuation prompts", () => {
    const messages: DisplayedMessage[] = [
      userMessage("real", "Please continue the work", 1),
      userMessage("auto", "Continue", 2, { isSynthetic: true }),
      userMessage("goal", "Synthetic goal continuation", 3, { isGoalContinuation: true }),
      userMessage("wrap", "Budget wrap-up", 4, { isBudgetLimitWrapup: true }),
    ];

    expect(getPromptHistoryEntries(messages).map((entry) => entry.historyId)).toEqual(["real"]);
  });

  test("keeps attachment-only user prompts with file parts", () => {
    const fileParts = [
      {
        url: "data:text/plain;base64,SGVsbG8=",
        mediaType: "text/plain",
        filename: "note.txt",
      },
    ];
    const entries = getPromptHistoryEntries([
      userMessage("file-only", "", 1, {
        fileParts,
      }),
    ]);

    expect(entries).toEqual([
      {
        historyId: "file-only",
        content: "",
        historySequence: 1,
        timestamp: undefined,
        commandPrefix: undefined,
        isSideQuestion: false,
        fileCount: 1,
        fileParts,
      },
    ]);
  });
});
