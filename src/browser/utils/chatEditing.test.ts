import { describe, expect, test } from "bun:test";
import type { DisplayedUserMessage, QueuedMessage } from "@/common/types/message";
import {
  canEditDisplayedUserMessage,
  isPureMonitorWakeQueue,
  normalizeQueuedMessage,
} from "./chatEditing";

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

describe("isPureMonitorWakeQueue", () => {
  const baseQueued = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
    id: "queued",
    content: "",
    ...overrides,
  });
  const wakeXml =
    '<monitor-event source="mux" taskId="bash:1" total_matches="1"><line>FAIL boot</line></monitor-event>';

  test("returns false when the queue is not flagged as containing monitor events", () => {
    expect(isPureMonitorWakeQueue(baseQueued({ content: wakeXml }))).toBe(false);
  });

  test("returns true for a flagged queue with only the synthetic wake", () => {
    // Edit/restore shortcut paths must bail in this case so the wake stays queued instead of
    // being silently dropped into an empty composer.
    expect(
      isPureMonitorWakeQueue(baseQueued({ content: wakeXml, containsMonitorEvents: true }))
    ).toBe(true);
  });

  test("returns false when user-authored text is mixed with the wake", () => {
    expect(
      isPureMonitorWakeQueue(
        baseQueued({ content: `investigate this\n${wakeXml}`, containsMonitorEvents: true })
      )
    ).toBe(false);
  });

  test("returns false when attachments accompany the wake", () => {
    expect(
      isPureMonitorWakeQueue(
        baseQueued({
          content: wakeXml,
          containsMonitorEvents: true,
          fileParts: [{ url: "file:///tmp/a.png", mediaType: "image/png" }],
        })
      )
    ).toBe(false);
  });
});
