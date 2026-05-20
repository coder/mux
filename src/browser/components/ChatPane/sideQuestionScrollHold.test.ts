import { describe, expect, test } from "bun:test";
import type { DisplayedMessage } from "@/common/types/message";
import {
  findActiveSideQuestionScrollHoldTarget,
  findSideQuestionScrollHoldTarget,
} from "./sideQuestionScrollHold";

function userMessage(
  historyId: string,
  opts: { isSideQuestion?: boolean } = {}
): Extract<DisplayedMessage, { type: "user" }> {
  return {
    type: "user",
    id: `${historyId}-0`,
    historyId,
    content: historyId,
    historySequence: 1,
    isSideQuestion: opts.isSideQuestion,
  };
}

function assistantMessage(
  historyId: string,
  opts: { isSideAnswer?: boolean; isStreaming?: boolean } = {}
): Extract<DisplayedMessage, { type: "assistant" }> {
  return {
    type: "assistant",
    id: `${historyId}-0`,
    historyId,
    content: historyId,
    historySequence: 1,
    isStreaming: opts.isStreaming ?? false,
    isPartial: false,
    isCompacted: false,
    isIdleCompacted: false,
    isSideAnswer: opts.isSideAnswer,
  };
}

function state(overrides: Partial<Parameters<typeof findSideQuestionScrollHoldTarget>[1]> = {}) {
  return {
    initialized: true,
    heldSideQuestionIds: new Set<string>(),
    previouslyStreamingSideAnswerIds: new Set<string>(),
    heldSideAnswerIds: new Set<string>(),
    ...overrides,
  };
}

describe("findSideQuestionScrollHoldTarget", () => {
  test("targets a newly visible side question when transcript rows already exist below it", () => {
    const messages: DisplayedMessage[] = [
      assistantMessage("main-1"),
      userMessage("btw-q", { isSideQuestion: true }),
      assistantMessage("main-1-post"),
    ];

    const result = findSideQuestionScrollHoldTarget(messages, state());

    expect(result.targetHistoryId).toBe("btw-q");
    expect([...result.nextState.heldSideQuestionIds]).toEqual(["btw-q"]);
  });

  test("waits to target a new side question until rows appear below it", () => {
    const first = findSideQuestionScrollHoldTarget(
      [assistantMessage("main-1"), userMessage("btw-q", { isSideQuestion: true })],
      state()
    );
    expect(first.targetHistoryId).toBeUndefined();
    expect([...first.nextState.heldSideQuestionIds]).toEqual([]);

    const second = findSideQuestionScrollHoldTarget(
      [
        assistantMessage("main-1"),
        userMessage("btw-q", { isSideQuestion: true }),
        assistantMessage("main-1-post"),
      ],
      first.nextState
    );

    expect(second.targetHistoryId).toBe("btw-q");
    expect([...second.nextState.heldSideQuestionIds]).toEqual(["btw-q"]);
  });

  test("does not target a standalone side question when only its answer is below it", () => {
    const messages: DisplayedMessage[] = [
      assistantMessage("main-1"),
      userMessage("btw-q", { isSideQuestion: true }),
      assistantMessage("btw-a", { isSideAnswer: true, isStreaming: true }),
    ];

    const result = findSideQuestionScrollHoldTarget(messages, state());

    expect(result.targetHistoryId).toBeUndefined();
    expect([...result.nextState.heldSideQuestionIds]).toEqual([]);
  });

  test("targets the side question when a streaming side answer has transcript rows below it", () => {
    const messages: DisplayedMessage[] = [
      assistantMessage("main-1"),
      userMessage("btw-q", { isSideQuestion: true }),
      assistantMessage("btw-a", { isSideAnswer: true, isStreaming: true }),
      assistantMessage("main-1-post"),
    ];

    const result = findSideQuestionScrollHoldTarget(
      messages,
      state({ heldSideQuestionIds: new Set(["btw-q"]) })
    );

    expect(result.targetHistoryId).toBe("btw-q");
    expect([...result.nextState.previouslyStreamingSideAnswerIds]).toEqual(["btw-a"]);
    expect([...result.nextState.heldSideAnswerIds]).toEqual(["btw-a"]);
  });

  test("does not target while the side answer is still the transcript tail", () => {
    const messages: DisplayedMessage[] = [
      assistantMessage("main-1"),
      userMessage("btw-q", { isSideQuestion: true }),
      assistantMessage("btw-a", { isSideAnswer: true, isStreaming: true }),
    ];

    const result = findSideQuestionScrollHoldTarget(
      messages,
      state({ heldSideQuestionIds: new Set(["btw-q"]) })
    );

    expect(result.targetHistoryId).toBeUndefined();
    expect([...result.nextState.previouslyStreamingSideAnswerIds]).toEqual(["btw-a"]);
    expect([...result.nextState.heldSideAnswerIds]).toEqual([]);
  });

  test("targets a side answer that just settled when transcript rows now exist below it", () => {
    const messages: DisplayedMessage[] = [
      assistantMessage("main-1"),
      userMessage("btw-q", { isSideQuestion: true }),
      assistantMessage("btw-a", { isSideAnswer: true, isStreaming: false }),
      assistantMessage("main-1-post"),
    ];

    const result = findSideQuestionScrollHoldTarget(
      messages,
      state({
        heldSideQuestionIds: new Set(["btw-q"]),
        previouslyStreamingSideAnswerIds: new Set(["btw-a"]),
      })
    );

    expect(result.targetHistoryId).toBe("btw-q");
    expect([...result.nextState.previouslyStreamingSideAnswerIds]).toEqual([]);
    expect([...result.nextState.heldSideAnswerIds]).toEqual(["btw-a"]);
  });

  test("does not target the same side answer more than once", () => {
    const messages: DisplayedMessage[] = [
      assistantMessage("main-1"),
      userMessage("btw-q", { isSideQuestion: true }),
      assistantMessage("btw-a", { isSideAnswer: true, isStreaming: true }),
      assistantMessage("main-1-post"),
    ];

    const result = findSideQuestionScrollHoldTarget(
      messages,
      state({
        heldSideQuestionIds: new Set(["btw-q"]),
        previouslyStreamingSideAnswerIds: new Set(["btw-a"]),
        heldSideAnswerIds: new Set(["btw-a"]),
      })
    );

    expect(result.targetHistoryId).toBeUndefined();
    expect([...result.nextState.previouslyStreamingSideAnswerIds]).toEqual(["btw-a"]);
    expect([...result.nextState.heldSideAnswerIds]).toEqual(["btw-a"]);
  });

  test("does not target side questions already present on initial render", () => {
    const messages: DisplayedMessage[] = [
      assistantMessage("main-1"),
      userMessage("btw-q", { isSideQuestion: true }),
      assistantMessage("btw-a", { isSideAnswer: true, isStreaming: false }),
      assistantMessage("main-2"),
    ];

    const result = findSideQuestionScrollHoldTarget(messages, state({ initialized: false }));

    expect(result.targetHistoryId).toBeUndefined();
    expect([...result.nextState.heldSideQuestionIds]).toEqual(["btw-q"]);
  });

  test("does not target settled historical side answers after initial render", () => {
    const messages: DisplayedMessage[] = [
      assistantMessage("main-1"),
      userMessage("btw-q", { isSideQuestion: true }),
      assistantMessage("btw-a", { isSideAnswer: true, isStreaming: false }),
      assistantMessage("main-2"),
    ];

    const result = findSideQuestionScrollHoldTarget(
      messages,
      state({ heldSideQuestionIds: new Set(["btw-q"]) })
    );

    expect(result.targetHistoryId).toBeUndefined();
  });

  test("keeps an active side-question hold aligned while its answer grows", () => {
    const withoutAnswer = findActiveSideQuestionScrollHoldTarget(
      [assistantMessage("main-1"), userMessage("btw-q", { isSideQuestion: true })],
      "btw-q"
    );
    expect(withoutAnswer).toEqual({ targetHistoryId: "btw-q", keepActive: true });

    const streamingAnswer = findActiveSideQuestionScrollHoldTarget(
      [
        assistantMessage("main-1"),
        userMessage("btw-q", { isSideQuestion: true }),
        assistantMessage("btw-a", { isSideAnswer: true, isStreaming: true }),
        assistantMessage("main-1-post"),
      ],
      "btw-q"
    );
    expect(streamingAnswer).toEqual({ targetHistoryId: "btw-q", keepActive: true });

    const settledAnswer = findActiveSideQuestionScrollHoldTarget(
      [
        assistantMessage("main-1"),
        userMessage("btw-q", { isSideQuestion: true }),
        assistantMessage("btw-a", { isSideAnswer: true, isStreaming: false }),
        assistantMessage("main-1-post"),
      ],
      "btw-q"
    );
    expect(settledAnswer).toEqual({ targetHistoryId: "btw-q", keepActive: false });
  });

  test("falls back to the answer row when the side-question user row is unavailable", () => {
    const messages: DisplayedMessage[] = [
      assistantMessage("main-1"),
      assistantMessage("btw-a", { isSideAnswer: true, isStreaming: true }),
      assistantMessage("main-1-post"),
    ];

    const result = findSideQuestionScrollHoldTarget(messages, state());

    expect(result.targetHistoryId).toBe("btw-a");
  });
});
