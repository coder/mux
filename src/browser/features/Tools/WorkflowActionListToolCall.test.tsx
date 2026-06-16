import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type React from "react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MessageListProvider } from "@/browser/features/Messages/MessageListContext";
import { ToolNameProvider } from "@/browser/features/Messages/ToolNameContext";
import { getAutoExpandPrefsKey } from "@/common/constants/storage";
import { WorkflowActionListToolCall } from "./WorkflowActionListToolCall";

const TEST_WORKSPACE_ID = "workflow-action-list-tool-test";

function renderWithTooltip(ui: React.ReactElement) {
  return render(
    <ThemeProvider forcedTheme="dark">
      <TooltipProvider>{ui}</TooltipProvider>
    </ThemeProvider>
  );
}

function renderWithStickyToolProviders(ui: React.ReactElement) {
  return render(
    <ThemeProvider forcedTheme="dark">
      <MessageListProvider value={{ workspaceId: TEST_WORKSPACE_ID, latestMessageId: null }}>
        <ToolNameProvider toolName="workflow_action_list">
          <TooltipProvider>{ui}</TooltipProvider>
        </ToolNameProvider>
      </MessageListProvider>
    </ThemeProvider>
  );
}

function getStoredPrefs(): string | null {
  return globalThis.localStorage.getItem(getAutoExpandPrefsKey(TEST_WORKSPACE_ID));
}

function clickToolHeader(view: ReturnType<typeof render>, label: string) {
  const header = view.getByText(label).closest('[data-scroll-intent="ignore"]');
  expect(header).toBeTruthy();
  fireEvent.click(header as HTMLElement);
}

describe("WorkflowActionListToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
  });

  test("auto-collapses completed action lists without mutating sticky preferences", () => {
    const completedView = renderWithStickyToolProviders(
      <WorkflowActionListToolCall
        args={{}}
        status="completed"
        result={{
          actions: [
            {
              name: "git.changedFiles",
              scope: "built-in",
              sourcePath: "/__mux_builtin_workflow_actions__/git/changedFiles.js",
              executable: true,
              hasReconcile: false,
              metadata: {
                version: 1,
                description: "Return changed file lists.",
                effect: "read",
              },
            },
          ],
        }}
      />
    );

    expect(completedView.getByText("1 action")).toBeTruthy();
    expect(completedView.queryByText("git.changedFiles")).toBeNull();
    expect(getStoredPrefs()).toBeNull();
    completedView.unmount();

    const executingView = renderWithStickyToolProviders(
      <WorkflowActionListToolCall args={{}} status="executing" />
    );

    expect(executingView.container.textContent).toContain("Waiting for workflow result");
    expect(getStoredPrefs()).toBeNull();
  });

  test("renders action rows with effect and blocked badges after manual expansion", () => {
    const view = renderWithTooltip(
      <WorkflowActionListToolCall
        args={{}}
        status="completed"
        result={{
          actions: [
            {
              name: "git.changedFiles",
              scope: "built-in",
              sourcePath: "/__mux_builtin_workflow_actions__/git/changedFiles.js",
              executable: true,
              hasReconcile: false,
              metadata: {
                version: 1,
                description: "Return changed file lists.",
                effect: "read",
              },
            },
            {
              name: "audit.scan",
              scope: "project",
              sourcePath: "/repo/.mux/workflows/actions/audit/scan.js",
              executable: false,
              blockedReason: "Project is not trusted",
            },
          ],
        }}
      />
    );

    expect(view.getByText("2 actions")).toBeTruthy();
    expect(view.queryByText("git.changedFiles")).toBeNull();
    expect(view.queryByText("Project is not trusted")).toBeNull();

    clickToolHeader(view, "2 actions");

    expect(view.getByText("git.changedFiles")).toBeTruthy();
    expect(view.getByText("read")).toBeTruthy();
    expect(view.getByText("blocked")).toBeTruthy();
    // Blocked actions surface their reason in the row description slot.
    expect(view.getByText("Project is not trusted")).toBeTruthy();
  });

  test("expanding a row reveals source path and schemas", () => {
    const view = renderWithTooltip(
      <WorkflowActionListToolCall
        args={{}}
        status="completed"
        result={{
          actions: [
            {
              name: "git.changedFiles",
              scope: "built-in",
              sourcePath: "/__mux_builtin_workflow_actions__/git/changedFiles.js",
              executable: true,
              hasReconcile: true,
              metadata: {
                version: 1,
                description: "Return changed file lists.",
                effect: "read",
                inputSchema: { type: "object" },
                timeoutMs: 60_000,
              },
            },
          ],
        }}
      />
    );

    expect(view.queryByText("Input schema")).toBeNull();

    clickToolHeader(view, "1 action");
    fireEvent.click(view.getByRole("button", { expanded: false }));

    expect(view.getByText("/__mux_builtin_workflow_actions__/git/changedFiles.js")).toBeTruthy();
    expect(view.getByText("Input schema")).toBeTruthy();
    expect(view.queryByText("Output schema")).toBeNull();
    expect(view.getByText("reconcile")).toBeTruthy();
    expect(view.getByText("timeout 1m")).toBeTruthy();
  });
});
