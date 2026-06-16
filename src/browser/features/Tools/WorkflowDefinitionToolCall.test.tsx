import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type React from "react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MessageListProvider } from "@/browser/features/Messages/MessageListContext";
import { ToolNameProvider } from "@/browser/features/Messages/ToolNameContext";
import { getAutoExpandPrefsKey } from "@/common/constants/storage";
import { WorkflowListToolCall, WorkflowReadToolCall } from "./WorkflowDefinitionToolCall";

const source = `export default function workflow({ args, agent }) {
  const topic = args.topic ?? "workflow UI";
  return agent({ id: "review", prompt: "Review " + topic });
}`;

const TEST_WORKSPACE_ID = "workflow-definition-tool-test";

function renderWithTooltip(ui: React.ReactElement) {
  return render(
    <ThemeProvider forcedTheme="dark">
      <TooltipProvider>{ui}</TooltipProvider>
    </ThemeProvider>
  );
}

function renderWithStickyToolProviders(ui: React.ReactElement, toolName: string) {
  return render(
    <ThemeProvider forcedTheme="dark">
      <MessageListProvider value={{ workspaceId: TEST_WORKSPACE_ID, latestMessageId: null }}>
        <ToolNameProvider toolName={toolName}>
          <TooltipProvider>{ui}</TooltipProvider>
        </ToolNameProvider>
      </MessageListProvider>
    </ThemeProvider>
  );
}

function getStoredPrefs(): string | null {
  return globalThis.localStorage.getItem(getAutoExpandPrefsKey(TEST_WORKSPACE_ID));
}

function expectWorkflowHeaderBadge(view: ReturnType<typeof render>, label: string) {
  const workflowBadge = view.getByText("Workflow");
  const headerText = workflowBadge.closest('[data-scroll-intent="ignore"]')?.textContent ?? "";
  expect(headerText.indexOf("Workflow")).toBeLessThan(headerText.indexOf(label));
}

function clickToolHeader(view: ReturnType<typeof render>, label: string) {
  const header = view.getByText(label).closest('[data-scroll-intent="ignore"]');
  expect(header).toBeTruthy();
  fireEvent.click(header as HTMLElement);
}

describe("WorkflowDefinitionToolCall", () => {
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

  test("auto-collapses completed workflow_read without mutating sticky preferences", () => {
    const completedView = renderWithStickyToolProviders(
      <WorkflowReadToolCall
        args={{ name: "deep-research" }}
        status="completed"
        result={{
          descriptor: {
            name: "deep-research",
            description: "Deep research",
            scope: "built-in",
            executable: true,
          },
          source,
        }}
      />,
      "workflow_read"
    );

    expect(completedView.queryByText("Deep research")).toBeNull();
    expect(completedView.container.textContent).not.toContain("return agent");
    expect(getStoredPrefs()).toBeNull();
    completedView.unmount();

    const executingView = renderWithStickyToolProviders(
      <WorkflowReadToolCall args={{ name: "deep-research" }} status="executing" />,
      "workflow_read"
    );

    expect(executingView.container.textContent).toContain("Waiting for workflow result");
    expect(getStoredPrefs()).toBeNull();
  });

  test("renders workflow_read metadata and highlighted source", () => {
    const view = renderWithTooltip(
      <WorkflowReadToolCall
        args={{ name: "deep-research" }}
        status="completed"
        result={{
          descriptor: {
            name: "deep-research",
            description: "Deep research",
            scope: "built-in",
            executable: true,
          },
          source,
        }}
      />
    );

    expectWorkflowHeaderBadge(view, "deep-research");
    expect(view.queryByText("Deep research")).toBeNull();
    expect(view.container.textContent).not.toContain("return agent");

    clickToolHeader(view, "deep-research");

    expect(view.getByText("Deep research")).toBeTruthy();
    expect(view.container.textContent).toContain("return agent");
  });

  test("renders workflow_list as definition cards after manual expansion", () => {
    const view = renderWithTooltip(
      <WorkflowListToolCall
        args={{}}
        status="completed"
        result={{
          workflows: [
            {
              name: "deep-research",
              description: "Deep research",
              scope: "built-in",
              executable: true,
            },
            {
              name: "project-flow",
              description: "Needs trust",
              scope: "project",
              executable: false,
              blockedReason: "Project is not trusted",
            },
          ],
        }}
      />
    );

    expectWorkflowHeaderBadge(view, "list");
    expect(view.getByText("2 definitions")).toBeTruthy();
    expect(view.queryByText("blocked")).toBeNull();
    expect(view.queryByText("Project is not trusted")).toBeNull();

    clickToolHeader(view, "2 definitions");

    expect(view.queryByText("executable")).toBeNull();
    expect(view.getByText("blocked")).toBeTruthy();
    expect(view.getByText("Project is not trusted")).toBeTruthy();
  });
});
