import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { DisplayedMessage } from "@/common/types/message";
import { MessageRenderer } from "./MessageRenderer";

describe("MessageRenderer goal continuation rows", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
  });

  afterEach(() => {
    cleanup();

    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    globalThis.localStorage = undefined as unknown as Storage;
  });

  test("labels synthetic active-goal continuation user messages", () => {
    const message: DisplayedMessage = {
      type: "user",
      id: "goal-continuation",
      historyId: "goal-continuation",
      content: "Continue working on the active workspace goal.",
      historySequence: 20,
      isSynthetic: true,
      isGoalContinuation: true,
    };

    const { getByText, queryByText } = render(
      <TooltipProvider>
        <MessageRenderer message={message} />
      </TooltipProvider>
    );

    expect(getByText("goal continuation")).toBeDefined();
    expect(queryByText("auto")).toBeNull();
  });

  test("labels synthetic budget-limit wrap-up messages distinctly", () => {
    const message: DisplayedMessage = {
      type: "user",
      id: "goal-budget-wrapup",
      historyId: "goal-budget-wrapup",
      content: "The budget for this goal has been exhausted.",
      historySequence: 21,
      isSynthetic: true,
      isBudgetLimitWrapup: true,
    };

    const { getByText, queryByText } = render(
      <TooltipProvider>
        <MessageRenderer message={message} />
      </TooltipProvider>
    );

    expect(getByText("budget limit wrap-up")).toBeDefined();
    expect(queryByText("goal continuation")).toBeNull();
    expect(queryByText("auto")).toBeNull();
  });
});

describe("MessageRenderer compaction boundary rows", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();

    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("renders start compaction boundary rows", () => {
    const message: DisplayedMessage = {
      type: "compaction-boundary",
      id: "boundary-start",
      historySequence: 10,
      position: "start",
      compactionEpoch: 4,
    };

    const { getByTestId, getByText } = render(<MessageRenderer message={message} />);

    const boundary = getByTestId("compaction-boundary");
    expect(boundary).toBeDefined();
    expect(boundary.getAttribute("role")).toBe("separator");
    expect(boundary.getAttribute("aria-orientation")).toBe("horizontal");
    expect(boundary.getAttribute("aria-label")).toBe("Compaction boundary #4");
    expect(getByText("Compaction boundary #4")).toBeDefined();
  });

  test("renders compaction boundary label for legacy end rows", () => {
    const message: DisplayedMessage = {
      type: "compaction-boundary",
      id: "boundary-end",
      historySequence: 10,
      position: "end",
      compactionEpoch: 4,
    };

    const { getByTestId, getByText } = render(<MessageRenderer message={message} />);

    const boundary = getByTestId("compaction-boundary");
    expect(boundary.getAttribute("aria-label")).toBe("Compaction boundary #4");
    expect(getByText("Compaction boundary #4")).toBeDefined();
  });
});
