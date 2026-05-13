import { describe, expect, test } from "bun:test";
import type { DisplayedUserMessage, QueuedMessage } from "@/common/types/message";
import { canEditDisplayedUserMessage, normalizeQueuedMessage } from "./chatEditing";

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

  test("allows normal user messages", () => {
    expect(canEditDisplayedUserMessage(userMessage())).toBe(true);
  });
});

describe("normalizeQueuedMessage", () => {
  const baseQueued = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
    id: "queued",
    content: "",
    ...overrides,
  });

  test("passes content through verbatim when no monitor flag is set", () => {
    // The flag gate prevents user-authored XML that resembles `<monitor-event>` from being
    // silently stripped when the user opens the Edit composer.
    const verbatim =
      '<monitor-event source="mux" taskId="bash:1" total_matches="1"></monitor-event>';
    expect(normalizeQueuedMessage(baseQueued({ content: verbatim })).content).toBe(verbatim);
  });

  test("strips backend-generated monitor XML when the queue is flagged", () => {
    const raw = [
      "investigate this",
      '<monitor-event source="mux" taskId="bash:1" total_matches="1"><line>FAIL boot</line></monitor-event>',
    ].join("\n");
    const result = normalizeQueuedMessage(
      baseQueued({ content: raw, containsMonitorEvents: true })
    );
    expect(result.content).toBe("investigate this");
  });
});
