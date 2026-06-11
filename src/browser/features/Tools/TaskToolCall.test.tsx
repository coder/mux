import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";

import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

let workspaceContextMock: { workspaceMetadata: Map<string, FrontendWorkspaceMetadata> } | null =
  null;

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useOptionalWorkspaceContext: () => workspaceContextMock,
  toWorkspaceSelection: (workspace: FrontendWorkspaceMetadata) => workspace,
}));

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
    workspaceContextMock = null;
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

  test("uses valid legacy agentType for task_await rows when agentId is invalid", () => {
    workspaceContextMock = {
      workspaceMetadata: new Map([
        [
          "task-1",
          {
            id: "task-1",
            name: "agent_explore_task",
            projectName: "project",
            projectPath: "/project",
            runtimeConfig: { type: "local" },
            namedWorkspacePath: "/project/task",
            parentWorkspaceId: "parent-1",
            agentId: "???",
            agentType: "explore",
            taskStatus: "running",
          },
        ],
      ]),
    };

    const view = renderTaskAwaitToolCall();

    fireEvent.click(view.getByText("task_await"));

    expect(view.getByText("explore")).toBeDefined();
    expect(view.queryByText("???")).toBeNull();
  });
});

const taskTerminateArgs = { task_ids: ["wfr_x"] };
const TaskTerminateToolCall = getToolComponent("task_terminate", taskTerminateArgs);

describe("TaskTerminateToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    workspaceContextMock = null;
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("summarizes interrupted workflow runs and reveals the note when expanded", () => {
    const note = "Workflow run interrupted durably; resume it with workflow_resume.";
    const view = render(
      <TooltipProvider>
        <TaskTerminateToolCall
          args={taskTerminateArgs}
          status="completed"
          result={{ results: [{ status: "interrupted", taskId: "wfr_x", note }] }}
        />
      </TooltipProvider>
    );

    // Interrupted workflow runs are a successful outcome, not a still-pending termination.
    expect(view.getByText("1 interrupted")).toBeDefined();
    expect(view.queryByText("1 to terminate")).toBeNull();
    expect(view.queryByText(note)).toBeNull();

    fireEvent.click(view.getByText("task_terminate"));

    expect(view.getByText(note)).toBeDefined();
    const badge = view.getByText("interrupted");
    expect(badge.className).toContain("text-interrupted");
  });
});
