import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";

void mock.module("./SubagentTranscriptDialog", () => ({
  SubagentTranscriptDialog: () => null,
}));

void mock.module("./Shared/ElapsedTimeDisplay", () => ({
  ElapsedTimeDisplay: ({
    startedAt,
    isActive,
    prefix,
    separator,
  }: {
    startedAt: number | undefined;
    isActive: boolean;
    prefix?: string;
    separator?: string;
  }) => (
    <span
      data-testid="elapsed-time"
      data-active={String(isActive)}
      data-prefix={prefix ?? ""}
      data-separator={separator ?? " • "}
      data-started-at={startedAt == null ? "missing" : String(startedAt)}
    />
  ),
}));

import { getToolComponent } from "./Shared/getToolComponent";

const taskAwaitArgs = { task_ids: ["task-1"], timeout_secs: 70 };
const TaskAwaitToolCall = getToolComponent("task_await", taskAwaitArgs);

function renderTaskAwaitToolCall(props: Record<string, unknown> = {}) {
  return render(
    <TooltipProvider>
      <TaskAwaitToolCall
        args={taskAwaitArgs}
        status="executing"
        startedAt={1_700_000_000_000}
        {...props}
      />
    </TooltipProvider>
  );
}

describe("TaskAwaitToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("shows elapsed time while task_await is executing", () => {
    const startedAt = 1_700_000_000_123;

    const view = renderTaskAwaitToolCall({ startedAt });

    const timer = view.getByTestId("elapsed-time");
    expect(timer.dataset.active).toBe("true");
    expect(timer.dataset.startedAt).toBe(String(startedAt));
    expect(timer.dataset.prefix).toBe("elapsed ");
    expect(timer.dataset.separator).toBe("");
  });
});
