import type { ComponentProps } from "react";
import type { AdvisorLivePhaseState } from "@/browser/stores/WorkspaceStore";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";

const useAdvisorToolLivePhaseMock = mock(
  (
    _workspaceId: string | undefined,
    _toolCallId: string | undefined
  ): AdvisorLivePhaseState | undefined => undefined
);

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  useAdvisorToolLivePhase: useAdvisorToolLivePhaseMock,
}));

void mock.module("./Shared/ElapsedTimeDisplay", () => ({
  ElapsedTimeDisplay: ({
    startedAt,
    isActive,
  }: {
    startedAt: number | undefined;
    isActive: boolean;
  }) => (
    <span
      data-testid="elapsed-time"
      data-active={String(isActive)}
      data-started-at={startedAt == null ? "missing" : String(startedAt)}
    />
  ),
}));

import { AdvisorToolCall } from "./AdvisorToolCall";

function renderAdvisorToolCall(props: Partial<ComponentProps<typeof AdvisorToolCall>> = {}) {
  return render(
    <TooltipProvider>
      <AdvisorToolCall
        args={{}}
        status="executing"
        workspaceId="workspace-1"
        toolCallId="advisor-call-1"
        startedAt={1_700_000_000_000}
        {...props}
      />
    </TooltipProvider>
  );
}

describe("AdvisorToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    useAdvisorToolLivePhaseMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("shows live phase timing in collapsed and expanded executing states", () => {
    const startedAt = 1_700_000_000_123;

    useAdvisorToolLivePhaseMock.mockReturnValue({
      phase: "waiting_for_response",
      timestamp: startedAt + 250,
    });

    const view = renderAdvisorToolCall({ startedAt });

    expect(useAdvisorToolLivePhaseMock).toHaveBeenCalledWith("workspace-1", "advisor-call-1");
    expect(view.getByText("Waiting for response")).toBeTruthy();

    let timers = view.getAllByTestId("elapsed-time");
    expect(timers).toHaveLength(1);
    expect(timers[0]?.dataset.active).toBe("true");
    expect(timers[0]?.dataset.startedAt).toBe(String(startedAt));

    fireEvent.click(view.getByText("advisor"));

    expect(view.getAllByText("Waiting for response")).toHaveLength(2);
    timers = view.getAllByTestId("elapsed-time");
    expect(timers).toHaveLength(2);
    for (const timer of timers) {
      expect(timer.dataset.active).toBe("true");
      expect(timer.dataset.startedAt).toBe(String(startedAt));
    }
  });

  test("falls back to a generic running state before a live phase arrives", () => {
    useAdvisorToolLivePhaseMock.mockReturnValue(undefined);

    const view = renderAdvisorToolCall();

    expect(view.getByText("Running")).toBeTruthy();
    const timers = view.getAllByTestId("elapsed-time");
    expect(timers).toHaveLength(1);
    expect(timers[0]?.dataset.active).toBe("true");
  });

  test("renders the advisor question when present", () => {
    useAdvisorToolLivePhaseMock.mockReturnValue(undefined);

    const view = renderAdvisorToolCall({
      args: { question: "  Should we split the refactor into smaller commits?  " },
      status: "completed",
      result: {
        type: "advice",
        advice: "Prefer the smaller diff so reviewers can verify it quickly.",
        advisorModel: "openai:gpt-4.1-mini",
        remainingUses: 1,
      },
    });

    fireEvent.click(view.getByText("advisor"));

    expect(view.getByText("Question")).toBeTruthy();
    expect(view.getByText("Should we split the refactor into smaller commits?")).toBeTruthy();
  });

  test("continues rendering completed advice results", () => {
    useAdvisorToolLivePhaseMock.mockReturnValue(undefined);

    const view = renderAdvisorToolCall({
      status: "completed",
      result: {
        type: "advice",
        advice: "Prefer the smaller diff so reviewers can verify it quickly.",
        advisorModel: "openai:gpt-4.1-mini",
        remainingUses: 1,
      },
    });

    fireEvent.click(view.getByText("advisor"));

    expect(
      view.getByText("Prefer the smaller diff so reviewers can verify it quickly.")
    ).toBeTruthy();
    expect(view.queryByTestId("elapsed-time")).toBeNull();
  });
});
