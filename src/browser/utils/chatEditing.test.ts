import { describe, expect, test } from "bun:test";
import type { DisplayedUserMessage } from "@/common/types/message";
import { canEditDisplayedUserMessage } from "./chatEditing";

function userMessage(overrides: Partial<DisplayedUserMessage> = {}): DisplayedUserMessage {
  return {
    type: "user",
    id: "user-message",
    historyId: "user-message",
    content: "hello",
    historySequence: 1,
    ...overrides,
  };
}

describe("canEditDisplayedUserMessage", () => {
  test("excludes goal-synthetic messages from all edit paths", () => {
    expect(canEditDisplayedUserMessage(userMessage({ isGoalContinuation: true }))).toBe(false);
    expect(canEditDisplayedUserMessage(userMessage({ isBudgetLimitWrapup: true }))).toBe(false);
  });

  test("excludes local command output messages", () => {
    expect(
      canEditDisplayedUserMessage(
        userMessage({ content: "<local-command-stdout>output</local-command-stdout>" })
      )
    ).toBe(false);
  });

  test("excludes messages before the latest context boundary", () => {
    expect(canEditDisplayedUserMessage(userMessage({ isBeforeLatestContextBoundary: true }))).toBe(
      false
    );
  });

  test("excludes side-question rows from edit paths", () => {
    expect(canEditDisplayedUserMessage(userMessage({ isSideQuestion: true }))).toBe(false);
  });

  test("allows normal user messages", () => {
    expect(canEditDisplayedUserMessage(userMessage())).toBe(true);
  });
});
