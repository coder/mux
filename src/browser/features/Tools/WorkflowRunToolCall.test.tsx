/* eslint-disable @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  type MouseEvent,
  type MouseEventHandler,
  type ReactElement,
  type ReactNode,
} from "react";

import { APIContext } from "@/browser/contexts/API";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  CommandRegistryProvider,
  useCommandRegistry,
  type CommandAction,
} from "@/browser/contexts/CommandRegistryContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
function createWorkflowTaskWorkspaceMetadata(workspaceId: string): FrontendWorkspaceMetadata {
  return {
    id: workspaceId,
    name: workspaceId,
    title: workspaceId,
    projectPath: "/repo",
    projectName: "repo",
    namedWorkspacePath: `/repo/${workspaceId}`,
    createdAt: "2026-05-29T00:00:00.000Z",
    runtimeConfig: { type: "local", srcBaseDir: "/tmp/mux-src" },
  };
}

interface MockDialogContextValue {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}

const MockDialogContext = createContext<MockDialogContextValue | null>(null);

interface MockDialogTriggerChildProps {
  onClick?: MouseEventHandler<HTMLElement>;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "dialog";
}

void mock.module("@/browser/components/Dialog/Dialog", () => ({
  Dialog: (props: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    children: ReactNode;
  }) => (
    <MockDialogContext.Provider value={{ open: props.open, onOpenChange: props.onOpenChange }}>
      {props.children}
    </MockDialogContext.Provider>
  ),
  DialogTrigger: (props: {
    asChild?: boolean;
    children: ReactElement<MockDialogTriggerChildProps>;
  }) => {
    const dialog = useContext(MockDialogContext);
    if (!props.asChild || !isValidElement<MockDialogTriggerChildProps>(props.children)) {
      throw new Error("Mock DialogTrigger expects asChild with a valid element");
    }

    return cloneElement(props.children, {
      "aria-expanded": dialog?.open ?? false,
      "aria-haspopup": "dialog",
      onClick: (event: MouseEvent<HTMLElement>) => {
        props.children.props.onClick?.(event);
        dialog?.onOpenChange?.(true);
      },
    });
  },
  DialogContent: (props: { children: ReactNode; className?: string }) => {
    const dialog = useContext(MockDialogContext);
    if (dialog?.open !== true) {
      return null;
    }

    return (
      <div role="dialog" className={props.className}>
        {props.children}
        <button type="button" aria-label="Close" onClick={() => dialog.onOpenChange?.(false)}>
          Close
        </button>
      </div>
    );
  },
  DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogTitle: (props: { children: ReactNode; className?: string }) => (
    <h2 className={props.className}>{props.children}</h2>
  ),
}));

import { WorkflowResumeToolCall, WorkflowRunToolCall } from "./WorkflowRunToolCall";

function APIHarness(props: { client: unknown; children: ReactNode }) {
  return (
    <APIContext.Provider
      value={{
        status: "connected",
        api: props.client as never,
        error: null,
        authenticate: () => undefined,
        retry: () => undefined,
      }}
    >
      {props.children}
    </APIContext.Provider>
  );
}

function CommandActionCapture(props: { onActions: (actions: CommandAction[]) => void }) {
  const registry = useCommandRegistry();
  useEffect(() => {
    props.onActions(registry.getActions());
  });
  return null;
}

function getWorkflowHeader(view: ReturnType<typeof render>): HTMLElement {
  const workflowBadge = view.getByText("Workflow");
  const header = workflowBadge.closest('[data-scroll-intent="ignore"]');
  if (header == null) {
    throw new Error("Workflow header not found");
  }
  return header as HTMLElement;
}

describe("WorkflowRunToolCall", () => {
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
    useWorkspaceStoreRaw().setNavigateToWorkspace(() => undefined);
    useWorkspaceStoreRaw().syncWorkspaces(new Map());
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
  });

  test("renders workflow run phases, linked task ids, and final report", async () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{
              name: "deep-research",
              args: { topic: "workflow cards" },
              run_in_background: false,
            }}
            status="completed"
            result={{
              status: "completed",
              runId: "wfr_123",
              result: {
                reportMarkdown: "# Final report\n\nWorkflow result body.",
                structuredOutput: { confidence: "medium" },
              },
              run: {
                id: "wfr_123",
                workspaceId: "workspace-1",
                definition: {
                  name: "deep-research",
                  description: "Deep research",
                  scope: "built-in",
                  executable: true,
                },
                definitionSource: "export default function workflow() { return null; }",
                definitionHash: "sha256:test",
                args: { topic: "workflow cards" },
                status: "completed",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:01.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "status",
                    at: "2026-05-29T00:00:00.000Z",
                    status: "running",
                  },
                  { sequence: 2, type: "phase", at: "2026-05-29T00:00:00.000Z", name: "scope" },
                  {
                    sequence: 3,
                    type: "log",
                    at: "2026-05-29T00:00:00.000Z",
                    message: "Scoped topic",
                    data: { topic: "workflow cards" },
                  },
                  {
                    sequence: 4,
                    type: "task",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "scope-topic",
                    taskId: "task_scope",
                    status: "completed",
                  },
                  {
                    sequence: 5,
                    type: "phase",
                    at: "2026-05-29T00:00:00.000Z",
                    name: "adversarial-verification",
                  },
                  {
                    sequence: 6,
                    type: "validation",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "adversarial-verify",
                    success: true,
                  },
                  {
                    sequence: 7,
                    type: "result",
                    at: "2026-05-29T00:00:01.000Z",
                    result: { reportMarkdown: "# Final report\n\nWorkflow result body." },
                  },
                  {
                    sequence: 8,
                    type: "status",
                    at: "2026-05-29T00:00:01.000Z",
                    status: "completed",
                  },
                ],
                steps: [
                  {
                    stepId: "scope-topic",
                    inputHash: "sha256:scope",
                    status: "completed",
                    taskId: "task_scope",
                    startedAt: "2026-05-29T00:00:00.000Z",
                    completedAt: "2026-05-29T00:00:01.000Z",
                    result: { reportMarkdown: "## Scope task report\n\nChild task report body." },
                  },
                ],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    expect(view.getAllByText("deep-research").length).toBeGreaterThan(0);
    const workflowHeader = getWorkflowHeader(view);
    expect(workflowHeader.textContent?.indexOf("Workflow") ?? -1).toBeLessThan(
      workflowHeader.textContent?.indexOf("deep-research") ?? -1
    );
    expect(view.queryByText("wfr_123")).toBeNull();

    fireEvent.click(workflowHeader);

    expect(view.getByText("wfr_123")).toBeTruthy();
    const getDisclosureForTitle = (title: string) => view.getByText(title).closest("details");
    expect(getDisclosureForTitle("Arguments")?.hasAttribute("open")).toBe(false);
    expect(getDisclosureForTitle("Definition source")?.hasAttribute("open")).toBe(false);
    expect(getDisclosureForTitle("Structured output")?.hasAttribute("open")).toBe(false);
    expect(view.container.textContent).toContain("workflow cards");
    expect(view.container.textContent).toContain("scope");
    expect(view.container.textContent).toContain("adversarial-verification");
    expect(view.container.textContent).toContain("task_scope");
    const firstEventIndex = view.getByText("#1");
    expect(firstEventIndex).toBeTruthy();
    expect(firstEventIndex.getAttribute("title")).toBeNull();
    expect(firstEventIndex.getAttribute("aria-label")).toBe("Raw event #2");
    expect(view.getByText("scope").closest("div")?.className).toContain("bg-plan-mode-alpha");
    expect(view.getByText("Scoped topic").closest("div")?.className).not.toContain(
      "bg-plan-mode-alpha"
    );
    expect(view.getByText("Workflow events (5)")).toBeTruthy();
    const taskEventRow = view.getByText("scope-topic / task_scope / completed");
    const taskEventIndex = view.getByText("#3");
    expect(taskEventIndex.className).toContain("cursor-help");
    expect(taskEventRow.closest('[role="button"]')).toBeNull();
    expect(taskEventRow.getAttribute("title")).toBeNull();
    expect(taskEventRow.closest("summary")).toBeNull();
    const taskReportToggle = view.getByLabelText("Open report for task_scope");
    expect(taskReportToggle.closest('[role="button"]')).toBeNull();

    fireEvent.click(taskReportToggle);

    await waitFor(() => {
      const reportDialog = document.querySelector('[role="dialog"]');
      expect(reportDialog?.textContent).toContain("Child task report body.");
    });
    await waitFor(() => expect(view.container.textContent).toContain("Workflow result body"));
    const renderedText = document.body.textContent ?? "";
    expect(renderedText.indexOf("confidence")).toBeLessThan(
      renderedText.indexOf("Workflow result body")
    );
    expect(renderedText).toContain("confidence");
  });

  test("coalesces task attempts, navigates active rows, expands completed outputs, opens workspaces, and opens reports", async () => {
    const navigatedTo: string[] = [];
    useWorkspaceStoreRaw().setNavigateToWorkspace((workspaceId) => {
      navigatedTo.push(workspaceId);
    });
    useWorkspaceStoreRaw().syncWorkspaces(
      new Map([
        ["task_live", createWorkflowTaskWorkspaceMetadata("task_live")],
        ["task_retry", createWorkflowTaskWorkspaceMetadata("task_retry")],
      ])
    );
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{ name: "implementation", args: {}, run_in_background: true }}
            status="executing"
            result={{
              status: "running",
              runId: "wfr_task_rows",
              result: null,
              run: {
                id: "wfr_task_rows",
                workspaceId: "workspace-1",
                definition: {
                  name: "implementation",
                  description: "Implementation",
                  scope: "built-in",
                  executable: true,
                },
                definitionSource: "export default function workflow() { return null; }",
                definitionHash: "sha256:test",
                args: {},
                status: "running",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:01.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "status",
                    at: "2026-05-29T00:00:00.000Z",
                    status: "running",
                  },
                  {
                    sequence: 2,
                    type: "task",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "implement",
                    taskId: "task_live",
                    status: "started",
                  },
                  {
                    sequence: 3,
                    type: "task",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "implement",
                    taskId: "task_live",
                    status: "completed",
                  },
                  {
                    sequence: 4,
                    type: "task",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "implement",
                    taskId: "task_retry",
                    status: "started",
                  },
                  {
                    sequence: 5,
                    type: "patch",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "apply-implement",
                    sourceTaskId: "task_live",
                    status: "started",
                  },
                ],
                steps: [
                  {
                    stepId: "implement",
                    inputHash: "sha256:implement-live",
                    status: "completed",
                    taskId: "task_live",
                    startedAt: "2026-05-29T00:00:00.000Z",
                    completedAt: "2026-05-29T00:00:01.000Z",
                    result: {
                      reportMarkdown: "## Implement report\n\nCompleted task body.",
                      structuredOutput: {
                        filesChanged: ["src/feature.ts"],
                        testsPassed: true,
                      },
                    },
                  },
                  {
                    stepId: "apply-implement",
                    inputHash: "sha256:patch",
                    status: "started",
                    taskId: "task_live",
                    startedAt: "2026-05-29T00:00:01.000Z",
                  },
                ],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    expect(view.getAllByText("implement / task_live / completed")).toHaveLength(1);
    expect(view.queryByText("implement / task_live / started")).toBeNull();
    expect(view.getByText("implement / task_retry / started")).toBeTruthy();
    expect(view.getByText("apply-implement / task_live / started")).toBeTruthy();
    const activeTaskControl = view.getByRole("button", {
      name: "Open workflow task task_retry",
    });
    const openAffordance = activeTaskControl.querySelector('[aria-hidden="true"]');
    expect(openAffordance?.textContent).toBe("Open");
    expect(view.queryByRole("button", { name: "Open" })).toBeNull();

    fireEvent.click(activeTaskControl);
    expect(navigatedTo).toEqual(["task_retry"]);
    fireEvent.keyDown(activeTaskControl, { key: "Enter" });
    expect(navigatedTo).toEqual(["task_retry", "task_retry"]);

    const completedTaskControl = view.getByRole("button", {
      name: "Expand structured output for workflow task task_live",
    });
    expect(completedTaskControl.textContent).toContain("implement / task_live / completed");
    expect(completedTaskControl.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent).not.toContain("filesChanged");
    expect(view.container.textContent).not.toContain("Completed task body.");

    fireEvent.keyDown(completedTaskControl, { key: "Enter" });

    expect(navigatedTo).toEqual(["task_retry", "task_retry"]);
    expect(completedTaskControl.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.textContent).toContain("filesChanged");
    expect(view.container.textContent).toContain("src/feature.ts");
    expect(view.container.textContent).toContain("testsPassed");
    const structuredOutputRegion = view.getByRole("region", {
      name: "Structured output for workflow task task_live",
    });
    expect(structuredOutputRegion.getAttribute("tabindex")).toBe("0");
    structuredOutputRegion.focus();
    expect(document.activeElement).toBe(structuredOutputRegion);
    expect(view.container.textContent).not.toContain("Completed task body.");

    const workspaceToggle = view.getByRole("button", { name: "Open task workspace for task_live" });
    expect(workspaceToggle.textContent).toBe("Workspace");
    fireEvent.click(workspaceToggle);
    expect(navigatedTo).toEqual(["task_retry", "task_retry", "task_live"]);

    const reportToggle = view.getByLabelText("Open report for task_live");
    expect(reportToggle.textContent).toBe("Report");
    expect(reportToggle.closest('[role="button"]')).toBeNull();
    fireEvent.click(reportToggle);

    expect(navigatedTo).toEqual(["task_retry", "task_retry", "task_live"]);
    await waitFor(() => {
      const reportDialog = document.querySelector('[role="dialog"]');
      expect(reportDialog?.textContent).toContain("Completed task body.");
    });

    fireEvent.click(view.getByLabelText("Close"));
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  test("labels task rows with the sub-agent title and falls back to stepId without one", () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{ name: "deep-research", args: {}, run_in_background: true }}
            status="executing"
            result={{
              status: "running",
              runId: "wfr_task_titles",
              result: null,
              run: {
                id: "wfr_task_titles",
                workspaceId: "workspace-1",
                definition: {
                  name: "deep-research",
                  description: "Deep research",
                  scope: "built-in",
                  executable: true,
                },
                definitionSource: "export default function workflow() { return null; }",
                definitionHash: "sha256:test",
                args: {},
                status: "running",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:01.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "status",
                    at: "2026-05-29T00:00:00.000Z",
                    status: "running",
                  },
                  {
                    sequence: 2,
                    type: "task",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "verify-claim-0-vote-2",
                    taskId: "task_verify",
                    status: "started",
                    title: "Verify claim 1 vote 3",
                  },
                  // Legacy persisted event without a title keeps the stepId label.
                  {
                    sequence: 3,
                    type: "task",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "extract-source-0",
                    taskId: "task_extract",
                    status: "started",
                  },
                ],
                steps: [],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    expect(view.getByText("Verify claim 1 vote 3 / task_verify / started")).toBeTruthy();
    expect(view.container.textContent).not.toContain("verify-claim-0-vote-2");
    expect(view.getByText("extract-source-0 / task_extract / started")).toBeTruthy();
  });

  test("coalesces action start and completion events into one row with combined details", () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{ name: "action-list", args: {}, run_in_background: true }}
            status="completed"
            result={{
              status: "completed",
              runId: "wfr_action_rows",
              result: null,
              run: {
                id: "wfr_action_rows",
                workspaceId: "workspace-1",
                definition: {
                  name: "action-list",
                  description: "Action list",
                  scope: "built-in",
                  executable: true,
                },
                definitionSource: "export default function workflow() { return null; }",
                definitionHash: "sha256:actions",
                args: {},
                status: "completed",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:02.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "action",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "git-status",
                    name: "git.status",
                    status: "started",
                    effect: "read",
                    sourcePath: "actions/git.ts",
                    sourceHash: "sha256:git",
                    details: { cwd: "/repo", input: { porcelain: true } },
                  },
                  {
                    sequence: 2,
                    type: "action",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "git-status",
                    name: "git.status",
                    status: "completed",
                    effect: "read",
                    sourcePath: "actions/git.ts",
                    sourceHash: "sha256:git",
                    details: { stdout: "clean", durationMs: 12 },
                  },
                  {
                    sequence: 3,
                    type: "action",
                    at: "2026-05-29T00:00:02.000Z",
                    stepId: "git-diff",
                    name: "git.diff",
                    status: "started",
                    effect: "read",
                    sourcePath: "actions/git.ts",
                    sourceHash: "sha256:git",
                    details: { cwd: "/repo", input: { stat: false } },
                  },
                ],
                steps: [],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    fireEvent.click(getWorkflowHeader(view));

    expect(view.getByText("Workflow events (2)")).toBeTruthy();
    expect(view.getAllByText("git-status / git.status / completed")).toHaveLength(1);
    expect(view.queryByText("git-status / git.status / started")).toBeNull();
    expect(view.getByText("git-diff / git.diff / started")).toBeTruthy();
    expect(view.getByText("#1").getAttribute("aria-label")).toBe("Raw event #1");

    fireEvent.click(view.getByText("git-status / git.status / completed"));

    expect(view.container.textContent).toContain("porcelain");
    expect(view.container.textContent).toContain("durationMs");
  });

  test("coalesces patch start and applied events into one row with combined details", () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{ name: "implementation", args: {}, run_in_background: true }}
            status="completed"
            result={{
              status: "completed",
              runId: "wfr_patch_rows",
              result: null,
              run: {
                id: "wfr_patch_rows",
                workspaceId: "workspace-1",
                definition: {
                  name: "implementation",
                  description: "Implementation",
                  scope: "built-in",
                  executable: true,
                },
                definitionSource: "export default function workflow() { return null; }",
                definitionHash: "sha256:patches",
                args: {},
                status: "completed",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:02.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "patch",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "apply-p0-p1",
                    sourceTaskId: "task_p0",
                    status: "started",
                    details: { target: "workspace" },
                  },
                  {
                    sequence: 2,
                    type: "patch",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "apply-p0-p1",
                    sourceTaskId: "task_p0",
                    status: "applied",
                    details: { commitCount: 3 },
                  },
                  {
                    sequence: 3,
                    type: "patch",
                    at: "2026-05-29T00:00:02.000Z",
                    stepId: "apply-p1-p2",
                    sourceTaskId: "task_p1",
                    status: "started",
                    details: { target: "workspace" },
                  },
                ],
                steps: [],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    fireEvent.click(getWorkflowHeader(view));

    expect(view.getByText("Workflow events (2)")).toBeTruthy();
    expect(view.getAllByText("apply-p0-p1 / task_p0 / applied")).toHaveLength(1);
    expect(view.queryByText("apply-p0-p1 / task_p0 / started")).toBeNull();
    expect(view.getByText("apply-p1-p2 / task_p1 / started")).toBeTruthy();
    expect(view.getByText("#1").getAttribute("aria-label")).toBe("Raw event #1");

    fireEvent.click(view.getByText("apply-p0-p1 / task_p0 / applied"));

    expect(view.container.textContent).toContain("target");
    expect(view.container.textContent).toContain("commitCount");
  });

  test("leaves cached action events separate from pending started rows", () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{ name: "action-list", args: {}, run_in_background: true }}
            status="completed"
            result={{
              status: "completed",
              runId: "wfr_action_cached_rows",
              result: null,
              run: {
                id: "wfr_action_cached_rows",
                workspaceId: "workspace-1",
                definition: {
                  name: "action-list",
                  description: "Action list",
                  scope: "built-in",
                  executable: true,
                },
                definitionSource: "export default function workflow() { return null; }",
                definitionHash: "sha256:cached-actions",
                args: {},
                status: "completed",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:02.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "action",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "git-status",
                    name: "git.status",
                    status: "started",
                    effect: "read",
                    sourcePath: "actions/git.ts",
                    sourceHash: "sha256:git",
                    details: { input: { marker: "stale-start" } },
                  },
                  {
                    sequence: 2,
                    type: "action",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "git-status",
                    name: "git.status",
                    status: "cached",
                    effect: "read",
                    sourcePath: "actions/git.ts",
                    sourceHash: "sha256:git",
                    details: { stdout: "cached-result" },
                  },
                ],
                steps: [],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    fireEvent.click(getWorkflowHeader(view));

    expect(view.getByText("Workflow events (2)")).toBeTruthy();
    expect(view.getByText("git-status / git.status / started")).toBeTruthy();
    expect(view.getByText("git-status / git.status / cached")).toBeTruthy();

    fireEvent.click(view.getByText("git-status / git.status / cached"));
    const cachedRow = view.getByText("git-status / git.status / cached").closest("details");
    if (cachedRow == null) {
      throw new Error("Expected cached action row details");
    }
    expect(cachedRow.textContent).toContain("cached-result");
    expect(cachedRow.textContent).not.toContain("stale-start");
  });

  test("preserves raw action rows when same-key starts overlap", () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{ name: "action-list", args: {}, run_in_background: true }}
            status="completed"
            result={{
              status: "completed",
              runId: "wfr_action_ambiguous_rows",
              result: null,
              run: {
                id: "wfr_action_ambiguous_rows",
                workspaceId: "workspace-1",
                definition: {
                  name: "action-list",
                  description: "Action list",
                  scope: "built-in",
                  executable: true,
                },
                definitionSource: "export default function workflow() { return null; }",
                definitionHash: "sha256:ambiguous-actions",
                args: {},
                status: "completed",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:04.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "action",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "git-status",
                    name: "git.status",
                    status: "started",
                    effect: "read",
                    sourcePath: "actions/git.ts",
                    sourceHash: "sha256:git",
                    details: { input: { marker: "first-start" } },
                  },
                  {
                    sequence: 2,
                    type: "action",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "git-status",
                    name: "git.status",
                    status: "started",
                    effect: "read",
                    sourcePath: "actions/git.ts",
                    sourceHash: "sha256:git",
                    details: { input: { marker: "second-start" } },
                  },
                  {
                    sequence: 3,
                    type: "action",
                    at: "2026-05-29T00:00:02.000Z",
                    stepId: "git-status",
                    name: "git.status",
                    status: "completed",
                    effect: "read",
                    sourcePath: "actions/git.ts",
                    sourceHash: "sha256:git",
                    details: { stdout: "first-finish" },
                  },
                  {
                    sequence: 4,
                    type: "action",
                    at: "2026-05-29T00:00:03.000Z",
                    stepId: "git-status",
                    name: "git.status",
                    status: "completed",
                    effect: "read",
                    sourcePath: "actions/git.ts",
                    sourceHash: "sha256:git",
                    details: { stdout: "second-finish" },
                  },
                ],
                steps: [],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    fireEvent.click(getWorkflowHeader(view));

    expect(view.getByText("Workflow events (4)")).toBeTruthy();
    expect(view.getAllByText("git-status / git.status / started")).toHaveLength(2);
    expect(view.getAllByText("git-status / git.status / completed")).toHaveLength(2);

    const firstCompletedLabel = view.getAllByText("git-status / git.status / completed")[0];
    if (firstCompletedLabel == null) {
      throw new Error("Expected at least one completed action row");
    }
    fireEvent.click(firstCompletedLabel);

    const completedRow = firstCompletedLabel.closest("details");
    if (completedRow == null) {
      throw new Error("Expected completed action row details");
    }
    expect(completedRow.textContent).toContain("first-finish");
    expect(completedRow.textContent).not.toContain("first-start");
    expect(completedRow.textContent).not.toContain("second-start");
  });

  test("hides task workspace actions when the task workspace is unavailable", async () => {
    const navigatedTo: string[] = [];
    useWorkspaceStoreRaw().setNavigateToWorkspace((workspaceId) => {
      navigatedTo.push(workspaceId);
    });
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{ name: "implementation", args: {}, run_in_background: true }}
            status="executing"
            result={{
              status: "running",
              runId: "wfr_missing_task_workspace",
              result: null,
              run: {
                id: "wfr_missing_task_workspace",
                workspaceId: "workspace-1",
                definition: {
                  name: "implementation",
                  description: "Implementation",
                  scope: "built-in",
                  executable: true,
                },
                definitionSource: "export default function workflow() { return null; }",
                definitionHash: "sha256:test",
                args: {},
                status: "running",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:01.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "task",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "completed-task",
                    taskId: "task_deleted_report",
                    status: "completed",
                  },
                  {
                    sequence: 2,
                    type: "task",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "running-task",
                    taskId: "task_deleted_running",
                    status: "started",
                  },
                ],
                steps: [
                  {
                    stepId: "completed-task",
                    inputHash: "sha256:completed",
                    status: "completed",
                    taskId: "task_deleted_report",
                    startedAt: "2026-05-29T00:00:00.000Z",
                    completedAt: "2026-05-29T00:00:01.000Z",
                    result: {
                      reportMarkdown: "## Deleted workspace report\n\nReport remains readable.",
                    },
                  },
                ],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    expect(view.queryByLabelText("Open task workspace for task_deleted_report")).toBeNull();
    expect(view.queryByText("Open")).toBeNull();
    expect(
      view.queryByRole("button", { name: "Open workflow task task_deleted_running" })
    ).toBeNull();
    expect(navigatedTo).toEqual([]);

    fireEvent.click(view.getByLabelText("Open report for task_deleted_report"));
    await waitFor(() => {
      const reportDialog = document.querySelector('[role="dialog"]');
      expect(reportDialog?.textContent).toContain("Report remains readable.");
    });
  });

  test("renders executing foreground workflow status before the durable run is discovered", () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{
              name: "deep-research",
              args: { topic: "workflow cards" },
              run_in_background: false,
            }}
            status="executing"
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    const workflowHeader = getWorkflowHeader(view);
    expect(workflowHeader.textContent).toContain("executing");
    expect(workflowHeader.textContent).not.toContain("pending");
  });

  test("discovers foreground workflow runs and renders live run details", async () => {
    const staleRun = {
      id: "wfr_stale",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:stale",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:01.000Z",
      events: [
        { sequence: 1, type: "phase" as const, at: "2026-05-28T00:00:01.000Z", name: "stale" },
      ],
      steps: [],
    };
    const foregroundRun = {
      ...staleRun,
      id: "wfr_foreground",
      definitionHash: "sha256:foreground",
      createdAt: "2026-05-29T00:00:00.490Z",
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:01.000Z",
          status: "running" as const,
        },
        { sequence: 2, type: "phase" as const, at: "2026-05-29T00:00:02.000Z", name: "scope" },
      ],
    };
    const interruptedForegroundRun = {
      ...foregroundRun,
      status: "interrupted" as const,
      updatedAt: "2026-05-29T00:00:03.000Z",
      events: [
        ...foregroundRun.events,
        {
          sequence: 3,
          type: "status" as const,
          at: "2026-05-29T00:00:03.000Z",
          status: "interrupted" as const,
        },
      ],
    };
    const listRuns = mock(async () => [staleRun, foregroundRun]);
    const getRun = mock(async () => foregroundRun);
    const interrupt = mock(async (input: { workspaceId: string; runId: string }) => {
      expect(input).toEqual({ workspaceId: "workspace-1", runId: "wfr_foreground" });
      return interruptedForegroundRun;
    });
    const api = {
      workflows: {
        listRuns,
        getRun,
        interrupt,
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: false,
              }}
              status="executing"
              workspaceId="workspace-1"
              startedAt={Date.parse("2026-05-29T00:00:00.500Z")}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(view.getByText("wfr_foreground")).toBeTruthy());
    expect(getWorkflowHeader(view).textContent).toContain("executing");
    expect(view.queryByText("wfr_stale")).toBeNull();
    expect(view.queryByText("stale")).toBeNull();
    expect(view.getAllByText("built-in").length).toBeGreaterThan(0);
    expect(view.getByText("Workflow events (1)")).toBeTruthy();
    expect(view.getByText("scope")).toBeTruthy();
    expect(listRuns).toHaveBeenCalledWith({ workspaceId: "workspace-1" });

    fireEvent.click(view.getByRole("button", { name: "Interrupt workflow" }));

    await waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getWorkflowHeader(view).textContent).toContain("interrupted"));
  });

  test("does not attach ambiguous foreground workflow run matches", async () => {
    const firstRun = {
      id: "wfr_first",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:first",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:01.000Z",
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        { sequence: 1, type: "phase" as const, at: "2026-05-29T00:00:02.000Z", name: "first" },
      ],
      steps: [],
    };
    const secondRun = {
      ...firstRun,
      id: "wfr_second",
      definitionHash: "sha256:second",
      updatedAt: "2026-05-29T00:00:03.000Z",
      events: [
        { sequence: 1, type: "phase" as const, at: "2026-05-29T00:00:03.000Z", name: "second" },
      ],
    };
    const listRuns = mock(async () => [firstRun, secondRun]);
    const getRun = mock(async () => secondRun);
    const api = {
      workflows: {
        listRuns,
        getRun,
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: false,
              }}
              status="executing"
              workspaceId="workspace-1"
              startedAt={Date.parse("2026-05-29T00:00:00.500Z")}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(listRuns).toHaveBeenCalledWith({ workspaceId: "workspace-1" }));
    expect(getWorkflowHeader(view).textContent).toContain("executing");
    expect(view.queryByText("wfr_first")).toBeNull();
    expect(view.queryByText("wfr_second")).toBeNull();
    expect(view.queryByText("first")).toBeNull();
    expect(view.queryByText("second")).toBeNull();
    expect(view.queryByRole("button", { name: "Interrupt workflow" })).toBeNull();
    expect(getRun).not.toHaveBeenCalled();
  });

  test("discovers workflow_resume runs by exact id and promotes the live run details", async () => {
    const runningRun = {
      id: "wfr_known",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:known",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:00.000Z",
          status: "running" as const,
        },
        { sequence: 2, type: "phase" as const, at: "2026-05-29T00:00:01.000Z", name: "scope" },
      ],
      steps: [],
    };
    const getRun = mock(async (input: { workspaceId: string; runId: string }) => {
      expect(input).toEqual({ workspaceId: "workspace-1", runId: "wfr_known" });
      return runningRun;
    });
    const api = {
      workflows: {
        getRun,
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowResumeToolCall
              args={{ run_id: "wfr_known", run_in_background: false }}
              status="executing"
              workspaceId="workspace-1"
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    // Until the snapshot loads, the run id doubles as the header display name.
    expect(getWorkflowHeader(view).textContent).toContain("wfr_known");

    await waitFor(() => expect(getWorkflowHeader(view).textContent).toContain("deep-research"));
    expect(getWorkflowHeader(view).textContent).not.toContain("wfr_known");
    expect(getWorkflowHeader(view).textContent).toContain("executing");
    expect(view.getByText("wfr_known")).toBeTruthy();
    expect(view.getAllByText("built-in").length).toBeGreaterThan(0);
    expect(view.getByText("Workflow events (1)")).toBeTruthy();
    expect(view.getByText("scope")).toBeTruthy();
    // The fetched snapshot matches the args' run id and this workspace, so the run is
    // actionable before the blocking tool call returns a result.
    expect(view.getByRole("button", { name: "Interrupt workflow" })).toBeTruthy();
    expect(getRun).toHaveBeenCalledWith({ workspaceId: "workspace-1", runId: "wfr_known" });
  });

  test("does not confirm workflow_resume identity for snapshots from another workspace", async () => {
    const otherWorkspaceRun = {
      id: "wfr_known",
      workspaceId: "workspace-other",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:known",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:00.000Z",
          status: "running" as const,
        },
      ],
      steps: [],
    };
    const getRun = mock(async () => otherWorkspaceRun);
    const api = {
      workflows: {
        getRun,
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowResumeToolCall
              args={{ run_id: "wfr_known", run_in_background: false }}
              status="executing"
              workspaceId="workspace-1"
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(getWorkflowHeader(view).textContent).toContain("deep-research"));
    // The snapshot still renders, but a cross-workspace id match must not unlock actions.
    expect(view.queryByRole("button", { name: "Interrupt workflow" })).toBeNull();
  });

  test("keeps polling workflow_resume past a stale interrupted snapshot until the run is live", async () => {
    const staleInterruptedRun = {
      id: "wfr_known",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:known",
      args: { topic: "workflow cards" },
      status: "interrupted" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:01.000Z",
          status: "interrupted" as const,
        },
      ],
      steps: [],
    };
    const resumedRun = {
      ...staleInterruptedRun,
      status: "running" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        ...staleInterruptedRun.events,
        {
          sequence: 2,
          type: "status" as const,
          at: "2026-05-29T00:00:02.000Z",
          status: "running" as const,
        },
        {
          sequence: 3,
          type: "phase" as const,
          at: "2026-05-29T00:00:02.000Z",
          name: "post-resume",
        },
      ],
    };
    let getRunCalls = 0;
    const getRun = mock(async () => {
      getRunCalls += 1;
      return getRunCalls === 1 ? staleInterruptedRun : resumedRun;
    });
    const api = {
      workflows: {
        getRun,
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowResumeToolCall
              args={{ run_id: "wfr_known", run_in_background: false }}
              status="executing"
              workspaceId="workspace-1"
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    // The first poll races the backend's resume transition and captures the stale pre-resume
    // "interrupted" snapshot; discovery must keep polling instead of pinning the card on it.
    await waitFor(() => expect(view.getByText("post-resume")).toBeTruthy());
    expect(getRunCalls).toBeGreaterThanOrEqual(2);
    expect(getWorkflowHeader(view).textContent).toContain("executing");
    expect(view.getByRole("button", { name: "Interrupt workflow" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Resume workflow" })).toBeNull();
  });

  test("keeps the newest workflow refresh snapshot when polls resolve out of order", async () => {
    const originalSetInterval = globalThis.window.setInterval;
    const originalClearInterval = globalThis.window.clearInterval;
    globalThis.window.setInterval = ((handler: TimerHandler) => {
      if (typeof handler === "function") {
        const callback = handler as () => void;
        queueMicrotask(callback);
      }
      return 1;
    }) as typeof globalThis.window.setInterval;
    globalThis.window.clearInterval = (() => undefined) as typeof globalThis.window.clearInterval;

    try {
      const runningRun = {
        id: "wfr_ordered",
        workspaceId: "workspace-1",
        definition: {
          name: "deep-research",
          description: "Deep research",
          scope: "built-in" as const,
          executable: true,
        },
        definitionSource: "export default function workflow() { return null; }",
        definitionHash: "sha256:ordered",
        args: { topic: "workflow cards" },
        status: "running" as const,
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:01.000Z",
        events: [
          { sequence: 1, type: "phase" as const, at: "2026-05-29T00:00:01.000Z", name: "initial" },
        ],
        steps: [],
      };
      const olderRun = {
        ...runningRun,
        updatedAt: "2026-05-29T00:00:03.000Z",
        events: [
          { sequence: 2, type: "phase" as const, at: "2026-05-29T00:00:03.000Z", name: "older" },
        ],
      };
      const newerRun = {
        ...runningRun,
        updatedAt: "2026-05-29T00:00:03.000Z",
        events: [
          { sequence: 3, type: "phase" as const, at: "2026-05-29T00:00:03.000Z", name: "newer" },
        ],
      };
      const refreshes: Array<(run: typeof runningRun) => void> = [];
      const api = {
        workflows: {
          getRun: mock(
            async () =>
              await new Promise<typeof runningRun>((resolve) => {
                refreshes.push(resolve);
              })
          ),
        },
      };

      const view = render(
        <APIHarness client={api}>
          <ThemeProvider forcedTheme="dark">
            <TooltipProvider>
              <WorkflowRunToolCall
                args={{
                  name: "deep-research",
                  args: { topic: "workflow cards" },
                  run_in_background: true,
                }}
                status="completed"
                result={{ status: "running", runId: "wfr_ordered", result: null, run: runningRun }}
              />
            </TooltipProvider>
          </ThemeProvider>
        </APIHarness>
      );

      await waitFor(() => expect(refreshes.length).toBeGreaterThanOrEqual(2));
      refreshes[1]?.(newerRun);
      await waitFor(() => expect(view.getByText("newer")).toBeTruthy());

      refreshes[0]?.(olderRun);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(view.getByText("newer")).toBeTruthy();
      expect(view.queryByText("older")).toBeNull();
    } finally {
      globalThis.window.setInterval = originalSetInterval;
      globalThis.window.clearInterval = originalClearInterval;
    }
  });

  test("keeps newer poll snapshots when an older action response resolves later", async () => {
    const runningRun = {
      id: "wfr_action_ordered",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:action-ordered",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        { sequence: 1, type: "phase" as const, at: "2026-05-29T00:00:01.000Z", name: "initial" },
      ],
      steps: [],
    };
    const olderRun = {
      ...runningRun,
      status: "interrupted" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        { sequence: 2, type: "phase" as const, at: "2026-05-29T00:00:02.000Z", name: "older" },
      ],
    };
    const newerRun = {
      ...runningRun,
      updatedAt: "2026-05-29T00:00:03.000Z",
      events: [
        { sequence: 3, type: "phase" as const, at: "2026-05-29T00:00:03.000Z", name: "newer" },
      ],
    };
    const refreshes: Array<(run: typeof runningRun) => void> = [];
    const pendingInterrupt: { resolve?: (run: typeof olderRun) => void } = {};
    const api = {
      workflows: {
        getRun: mock(
          async () =>
            await new Promise<typeof runningRun>((resolve) => {
              refreshes.push(resolve);
            })
        ),
        interrupt: mock(
          async () =>
            await new Promise<typeof olderRun>((resolve) => {
              pendingInterrupt.resolve = resolve;
            })
        ),
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "running",
                runId: "wfr_action_ordered",
                result: null,
                run: runningRun,
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(refreshes.length).toBe(1));
    fireEvent.click(view.getByText("Interrupt workflow"));
    await waitFor(() => expect(pendingInterrupt.resolve).toBeDefined());

    refreshes[0]?.(newerRun);
    await waitFor(() => expect(view.getByText("newer")).toBeTruthy());

    const completeInterrupt = pendingInterrupt.resolve;
    if (completeInterrupt == null) {
      throw new Error("Expected interrupt to be pending");
    }
    completeInterrupt(olderRun);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(view.getByText("newer")).toBeTruthy();
    expect(view.queryByText("older")).toBeNull();
  });

  test("refreshes a running workflow from the API and shows the completed result", async () => {
    const api = {
      workflows: {
        getRun: async () => ({
          id: "wfr_live",
          workspaceId: "workspace-1",
          definition: {
            name: "deep-research",
            description: "Deep research",
            scope: "built-in",
            executable: true,
          },
          definitionSource: "export default function workflow() { return null; }",
          definitionHash: "sha256:test",
          args: { topic: "workflow cards" },
          status: "completed",
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:00:02.000Z",
          events: [
            { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
            { sequence: 2, type: "phase", at: "2026-05-29T00:00:00.000Z", name: "scope" },
            {
              sequence: 3,
              type: "result",
              at: "2026-05-29T00:00:02.000Z",
              result: { reportMarkdown: "done live" },
            },
            { sequence: 4, type: "status", at: "2026-05-29T00:00:02.000Z", status: "completed" },
          ],
          steps: [],
        }),
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "running",
                runId: "wfr_live",
                result: null,
                run: {
                  id: "wfr_live",
                  workspaceId: "workspace-1",
                  definition: {
                    name: "deep-research",
                    description: "Deep research",
                    scope: "built-in",
                    executable: true,
                  },
                  definitionSource: "export default function workflow() { return null; }",
                  definitionHash: "sha256:test",
                  args: { topic: "workflow cards" },
                  status: "running",
                  createdAt: "2026-05-29T00:00:00.000Z",
                  updatedAt: "2026-05-29T00:00:01.000Z",
                  events: [
                    {
                      sequence: 1,
                      type: "status",
                      at: "2026-05-29T00:00:00.000Z",
                      status: "running",
                    },
                  ],
                  steps: [],
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(view.getAllByText("completed").length).toBeGreaterThan(0));
    expect(view.queryByText("done live")).toBeNull();

    fireEvent.click(getWorkflowHeader(view));

    expect(view.getByText("done live")).toBeTruthy();
  });

  test("keeps completed workflow runs expanded after the user toggles the card", async () => {
    const runningRun = {
      id: "wfr_manual",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:test",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:00.000Z",
          status: "running" as const,
        },
      ],
      steps: [],
    };
    const completedRun = {
      ...runningRun,
      status: "completed" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        ...runningRun.events,
        {
          sequence: 2,
          type: "result" as const,
          at: "2026-05-29T00:00:02.000Z",
          result: { reportMarkdown: "manual result" },
        },
        {
          sequence: 3,
          type: "status" as const,
          at: "2026-05-29T00:00:02.000Z",
          status: "completed" as const,
        },
      ],
    };
    const pendingRefresh: { resolve?: (run: typeof completedRun) => void } = {};
    const api = {
      workflows: {
        getRun: async () =>
          await new Promise<typeof completedRun>((resolve) => {
            pendingRefresh.resolve = resolve;
          }),
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{ status: "running", runId: "wfr_manual", result: null, run: runningRun }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(pendingRefresh.resolve).toBeDefined());
    const workflowHeader = getWorkflowHeader(view);
    fireEvent.click(workflowHeader);
    expect(view.queryByText("wfr_manual")).toBeNull();
    fireEvent.click(workflowHeader);
    expect(view.getByText("wfr_manual")).toBeTruthy();

    const completeRefresh = pendingRefresh.resolve;
    if (completeRefresh == null) {
      throw new Error("Expected workflow refresh to be pending");
    }
    completeRefresh(completedRun);

    await waitFor(() => expect(view.getByText("manual result")).toBeTruthy());
    expect(view.getAllByText("completed").length).toBeGreaterThan(0);
  });

  test("keeps open task report dialog mounted after workflow auto-completes", async () => {
    const runningRun = {
      id: "wfr_report_auto",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:test",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:00.000Z",
          status: "running" as const,
        },
        {
          sequence: 2,
          type: "task" as const,
          at: "2026-05-29T00:00:01.000Z",
          stepId: "report-step",
          taskId: "task_report",
          status: "completed" as const,
        },
      ],
      steps: [
        {
          stepId: "report-step",
          inputHash: "sha256:report",
          status: "completed" as const,
          taskId: "task_report",
          startedAt: "2026-05-29T00:00:00.000Z",
          completedAt: "2026-05-29T00:00:01.000Z",
          result: { reportMarkdown: "## Running task report\n\nReport stays open." },
        },
      ],
    };
    const completedRun = {
      ...runningRun,
      status: "completed" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        ...runningRun.events,
        {
          sequence: 3,
          type: "result" as const,
          at: "2026-05-29T00:00:02.000Z",
          result: { reportMarkdown: "completed workflow result" },
        },
        {
          sequence: 4,
          type: "status" as const,
          at: "2026-05-29T00:00:02.000Z",
          status: "completed" as const,
        },
      ],
    };
    const pendingRefresh: { resolve?: (run: typeof completedRun) => void } = {};
    const api = {
      workflows: {
        getRun: async () =>
          await new Promise<typeof completedRun>((resolve) => {
            pendingRefresh.resolve = resolve;
          }),
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "running",
                runId: "wfr_report_auto",
                result: null,
                run: runningRun,
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(pendingRefresh.resolve).toBeDefined());
    fireEvent.click(view.getByLabelText("Open report for task_report"));
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        "Report stays open."
      );
    });

    const completeRefresh = pendingRefresh.resolve;
    if (completeRefresh == null) {
      throw new Error("Expected workflow refresh to be pending");
    }
    completeRefresh(completedRun);

    await waitFor(() => expect(view.getByText("completed workflow result")).toBeTruthy());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Report stays open.");
  });

  test("keeps expanded task structured output visible after workflow auto-completes", async () => {
    const runningRun = {
      id: "wfr_structured_auto",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:test",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:00.000Z",
          status: "running" as const,
        },
        {
          sequence: 2,
          type: "task" as const,
          at: "2026-05-29T00:00:01.000Z",
          stepId: "structured-step",
          taskId: "task_structured",
          status: "completed" as const,
        },
      ],
      steps: [
        {
          stepId: "structured-step",
          inputHash: "sha256:structured",
          status: "completed" as const,
          taskId: "task_structured",
          startedAt: "2026-05-29T00:00:00.000Z",
          completedAt: "2026-05-29T00:00:01.000Z",
          result: {
            reportMarkdown: "## Structured task report\n\nReport remains available.",
            structuredOutput: {
              reviewSummary: "Keep this visible after completion.",
            },
          },
        },
      ],
    };
    const completedRun = {
      ...runningRun,
      status: "completed" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        ...runningRun.events,
        {
          sequence: 3,
          type: "result" as const,
          at: "2026-05-29T00:00:02.000Z",
          result: { reportMarkdown: "completed workflow result" },
        },
        {
          sequence: 4,
          type: "status" as const,
          at: "2026-05-29T00:00:02.000Z",
          status: "completed" as const,
        },
      ],
    };
    const pendingRefresh: { resolve?: (run: typeof completedRun) => void } = {};
    const api = {
      workflows: {
        getRun: async () =>
          await new Promise<typeof completedRun>((resolve) => {
            pendingRefresh.resolve = resolve;
          }),
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "running",
                runId: "wfr_structured_auto",
                result: null,
                run: runningRun,
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(pendingRefresh.resolve).toBeDefined());
    fireEvent.click(
      view.getByRole("button", {
        name: "Expand structured output for workflow task task_structured",
      })
    );
    expect(view.container.textContent).toContain("reviewSummary");

    const completeRefresh = pendingRefresh.resolve;
    if (completeRefresh == null) {
      throw new Error("Expected workflow refresh to be pending");
    }
    completeRefresh(completedRun);

    await waitFor(() => expect(view.getByText("completed workflow result")).toBeTruthy());
    expect(view.container.textContent).toContain("reviewSummary");
    expect(view.container.textContent).toContain("Keep this visible after completion.");
  });

  test("shows interrupt action for running workflows and updates with the returned run", async () => {
    let interrupted = false;
    const api = {
      workflows: {
        getRun: async () => null,
        interrupt: async () => {
          interrupted = true;
          return {
            id: "wfr_interrupt",
            workspaceId: "workspace-1",
            definition: {
              name: "deep-research",
              description: "Deep research",
              scope: "built-in",
              executable: true,
            },
            definitionSource: "export default function workflow() { return null; }",
            definitionHash: "sha256:test",
            args: { topic: "workflow cards" },
            status: "interrupted",
            createdAt: "2026-05-29T00:00:00.000Z",
            updatedAt: "2026-05-29T00:00:02.000Z",
            events: [
              { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
              {
                sequence: 2,
                type: "status",
                at: "2026-05-29T00:00:02.000Z",
                status: "interrupted",
              },
            ],
            steps: [],
          };
        },
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "running",
                runId: "wfr_interrupt",
                result: null,
                run: {
                  id: "wfr_interrupt",
                  workspaceId: "workspace-1",
                  definition: {
                    name: "deep-research",
                    description: "Deep research",
                    scope: "built-in",
                    executable: true,
                  },
                  definitionSource: "export default function workflow() { return null; }",
                  definitionHash: "sha256:test",
                  args: { topic: "workflow cards" },
                  status: "running",
                  createdAt: "2026-05-29T00:00:00.000Z",
                  updatedAt: "2026-05-29T00:00:01.000Z",
                  events: [
                    {
                      sequence: 1,
                      type: "status",
                      at: "2026-05-29T00:00:00.000Z",
                      status: "running",
                    },
                  ],
                  steps: [],
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    fireEvent.click(view.getByRole("button", { name: "Interrupt workflow" }));

    await waitFor(() => expect(interrupted).toBe(true));
    await waitFor(() => expect(view.getAllByText("interrupted").length).toBeGreaterThan(0));
  });

  test("registers workflow run actions with the command palette", async () => {
    let interrupted = false;
    let actions: CommandAction[] = [];
    const api = {
      workflows: {
        getRun: async () => null,
        interrupt: async () => {
          interrupted = true;
          return {
            id: "wfr_palette",
            workspaceId: "workspace-1",
            definition: {
              name: "deep-research",
              description: "Deep research",
              scope: "built-in",
              executable: true,
            },
            definitionSource: "export default function workflow() { return null; }",
            definitionHash: "sha256:test",
            args: { topic: "workflow cards" },
            status: "interrupted",
            createdAt: "2026-05-29T00:00:00.000Z",
            updatedAt: "2026-05-29T00:00:02.000Z",
            events: [
              { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
              {
                sequence: 2,
                type: "status",
                at: "2026-05-29T00:00:02.000Z",
                status: "interrupted",
              },
            ],
            steps: [],
          };
        },
      },
    };

    render(
      <CommandRegistryProvider>
        <APIHarness client={api}>
          <ThemeProvider forcedTheme="dark">
            <TooltipProvider>
              <WorkflowRunToolCall
                args={{
                  name: "deep-research",
                  args: { topic: "workflow cards" },
                  run_in_background: true,
                }}
                status="completed"
                result={{
                  status: "running",
                  runId: "wfr_palette",
                  result: null,
                  run: {
                    id: "wfr_palette",
                    workspaceId: "workspace-1",
                    definition: {
                      name: "deep-research",
                      description: "Deep research",
                      scope: "built-in",
                      executable: true,
                    },
                    definitionSource: "export default function workflow() { return null; }",
                    definitionHash: "sha256:test",
                    args: { topic: "workflow cards" },
                    status: "running",
                    createdAt: "2026-05-29T00:00:00.000Z",
                    updatedAt: "2026-05-29T00:00:01.000Z",
                    events: [
                      {
                        sequence: 1,
                        type: "status",
                        at: "2026-05-29T00:00:00.000Z",
                        status: "running",
                      },
                    ],
                    steps: [],
                  },
                }}
              />
              <CommandActionCapture onActions={(nextActions) => (actions = nextActions)} />
            </TooltipProvider>
          </ThemeProvider>
        </APIHarness>
      </CommandRegistryProvider>
    );

    await waitFor(() =>
      expect(actions.some((action) => action.id === "workflow:wfr_palette:interrupt")).toBe(true)
    );
    const interruptAction = actions.find(
      (action) => action.id === "workflow:wfr_palette:interrupt"
    );
    expect(interruptAction).toBeDefined();
    await interruptAction?.run();

    await waitFor(() => expect(interrupted).toBe(true));
  });

  test("shows resume action for interrupted workflows and refreshes after resume", async () => {
    let resumed = false;
    let getRunCalls = 0;
    const interruptedRun = {
      id: "wfr_resume",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:test",
      args: { topic: "workflow cards" },
      status: "interrupted" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:00.000Z",
          status: "interrupted" as const,
        },
      ],
      steps: [],
    };
    const completedRun = {
      ...interruptedRun,
      status: "completed" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        ...interruptedRun.events,
        {
          sequence: 2,
          type: "result" as const,
          at: "2026-05-29T00:00:02.000Z",
          result: { reportMarkdown: "resumed" },
        },
        {
          sequence: 3,
          type: "status" as const,
          at: "2026-05-29T00:00:02.000Z",
          status: "completed" as const,
        },
      ],
    };
    const api = {
      workflows: {
        resume: async () => {
          resumed = true;
          return {
            runId: "wfr_resume",
            status: "running" as const,
            result: null,
          };
        },
        getRun: async () => {
          getRunCalls += 1;
          return getRunCalls === 1 ? interruptedRun : completedRun;
        },
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "interrupted",
                runId: "wfr_resume",
                result: null,
                run: {
                  id: "wfr_resume",
                  workspaceId: "workspace-1",
                  definition: {
                    name: "deep-research",
                    description: "Deep research",
                    scope: "built-in",
                    executable: true,
                  },
                  definitionSource: "export default function workflow() { return null; }",
                  definitionHash: "sha256:test",
                  args: { topic: "workflow cards" },
                  status: "interrupted",
                  createdAt: "2026-05-29T00:00:00.000Z",
                  updatedAt: "2026-05-29T00:00:01.000Z",
                  events: [
                    {
                      sequence: 1,
                      type: "status",
                      at: "2026-05-29T00:00:00.000Z",
                      status: "interrupted",
                    },
                  ],
                  steps: [],
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    fireEvent.click(view.getByRole("button", { name: "Resume workflow" }));

    await waitFor(() => expect(resumed).toBe(true));
    await waitFor(() => expect(view.getAllByText("completed").length).toBeGreaterThan(0));
    expect(view.queryByText("resumed")).toBeNull();

    fireEvent.click(getWorkflowHeader(view));

    expect(view.getByText("resumed")).toBeTruthy();
  });

  test("shows retry from checkpoint for recoverable failed workflows", async () => {
    let retried = false;
    let getRunCalls = 0;
    const failedRun = {
      id: "wfr_retry",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:test",
      args: { topic: "workflow cards" },
      status: "failed" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "error" as const,
          at: "2026-05-29T00:00:00.000Z",
          message: "Execution interrupted",
        },
        {
          sequence: 2,
          type: "status" as const,
          at: "2026-05-29T00:00:01.000Z",
          status: "failed" as const,
        },
      ],
      steps: [],
    };
    const completedRun = {
      ...failedRun,
      status: "completed" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        ...failedRun.events,
        {
          sequence: 3,
          type: "status" as const,
          at: "2026-05-29T00:00:01.500Z",
          status: "running" as const,
        },
        {
          sequence: 4,
          type: "result" as const,
          at: "2026-05-29T00:00:02.000Z",
          result: { reportMarkdown: "retried" },
        },
        {
          sequence: 5,
          type: "status" as const,
          at: "2026-05-29T00:00:02.000Z",
          status: "completed" as const,
        },
      ],
    };
    const api = {
      workflows: {
        retryFromCheckpoint: async () => {
          retried = true;
          return {
            runId: "wfr_retry",
            status: "running" as const,
            result: null,
          };
        },
        getRun: async () => {
          getRunCalls += 1;
          return getRunCalls === 1 ? failedRun : completedRun;
        },
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{ status: "failed", runId: "wfr_retry", result: null, run: failedRun }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    fireEvent.click(view.getByRole("button", { name: "Retry from checkpoint" }));

    await waitFor(() => expect(retried).toBe(true));
    await waitFor(() => expect(view.getAllByText("completed").length).toBeGreaterThan(0));
    fireEvent.click(getWorkflowHeader(view));
    expect(view.getByText("retried")).toBeTruthy();
  });

  test("stops retry polling after an accepted retry reaches terminal failure", async () => {
    const originalSetInterval = globalThis.window.setInterval;
    const originalClearInterval = globalThis.window.clearInterval;
    let clearIntervalCalls = 0;
    const intervalRef: { handler: (() => void) | null } = { handler: null };
    const intervalId = 123;
    globalThis.window.setInterval = ((handler: () => void) => {
      intervalRef.handler = handler;
      return intervalId;
    }) as unknown as typeof window.setInterval;
    globalThis.window.clearInterval = ((id?: number) => {
      if (id === intervalId) {
        clearIntervalCalls += 1;
      }
    }) as unknown as typeof window.clearInterval;
    try {
      let getRunCalls = 0;
      const failedRun = {
        id: "wfr_retry_terminal_failed",
        workspaceId: "workspace-1",
        definition: {
          name: "deep-research",
          description: "Deep research",
          scope: "built-in" as const,
          executable: true,
        },
        definitionSource: "export default function workflow() { return null; }",
        definitionHash: "sha256:test",
        args: {},
        status: "failed" as const,
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:01.000Z",
        events: [
          {
            sequence: 1,
            type: "error" as const,
            at: "2026-05-29T00:00:00.000Z",
            message: "Execution interrupted",
          },
          {
            sequence: 2,
            type: "status" as const,
            at: "2026-05-29T00:00:01.000Z",
            status: "failed" as const,
          },
        ],
        steps: [],
      };
      const terminalFailedRun = {
        ...failedRun,
        updatedAt: "2026-05-29T00:00:04.000Z",
        events: [
          ...failedRun.events,
          {
            sequence: 3,
            type: "status" as const,
            at: "2026-05-29T00:00:02.000Z",
            status: "running" as const,
          },
          {
            sequence: 4,
            type: "error" as const,
            at: "2026-05-29T00:00:03.000Z",
            message: "retry failed",
          },
          {
            sequence: 5,
            type: "status" as const,
            at: "2026-05-29T00:00:04.000Z",
            status: "failed" as const,
          },
        ],
      };
      const api = {
        workflows: {
          retryFromCheckpoint: async () => ({
            runId: failedRun.id,
            status: "running" as const,
            result: null,
          }),
          getRun: async () => {
            getRunCalls += 1;
            return terminalFailedRun;
          },
        },
      };

      const view = render(
        <APIHarness client={api}>
          <ThemeProvider forcedTheme="dark">
            <TooltipProvider>
              <WorkflowRunToolCall
                args={{ name: "deep-research", args: {}, run_in_background: true }}
                status="completed"
                result={{ status: "failed", runId: failedRun.id, result: null, run: failedRun }}
              />
            </TooltipProvider>
          </ThemeProvider>
        </APIHarness>
      );

      fireEvent.click(view.getByRole("button", { name: "Retry from checkpoint" }));

      await waitFor(() => expect(getRunCalls).toBe(1));
      const pendingIntervalHandler = intervalRef.handler;
      if (clearIntervalCalls === 0 && pendingIntervalHandler != null) {
        pendingIntervalHandler();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getRunCalls).toBe(1);
    } finally {
      globalThis.window.setInterval = originalSetInterval;
      globalThis.window.clearInterval = originalClearInterval;
    }
  });

  test("stops resume polling after an accepted resume reaches terminal failure", async () => {
    const originalSetInterval = globalThis.window.setInterval;
    const originalClearInterval = globalThis.window.clearInterval;
    let clearIntervalCalls = 0;
    const intervalRef: { handler: (() => void) | null } = { handler: null };
    const intervalId = 456;
    globalThis.window.setInterval = ((handler: () => void) => {
      intervalRef.handler = handler;
      return intervalId;
    }) as unknown as typeof window.setInterval;
    globalThis.window.clearInterval = ((id?: number) => {
      if (id === intervalId) {
        clearIntervalCalls += 1;
      }
    }) as unknown as typeof window.clearInterval;
    try {
      let getRunCalls = 0;
      const interruptedRun = {
        id: "wfr_resume_terminal_failed",
        workspaceId: "workspace-1",
        definition: {
          name: "deep-research",
          description: "Deep research",
          scope: "built-in" as const,
          executable: true,
        },
        definitionSource: "export default function workflow() { return null; }",
        definitionHash: "sha256:test",
        args: {},
        status: "interrupted" as const,
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:01.000Z",
        events: [
          {
            sequence: 1,
            type: "status" as const,
            at: "2026-05-29T00:00:01.000Z",
            status: "interrupted" as const,
          },
        ],
        steps: [],
      };
      const terminalFailedRun = {
        ...interruptedRun,
        status: "failed" as const,
        updatedAt: "2026-05-29T00:00:04.000Z",
        events: [
          ...interruptedRun.events,
          {
            sequence: 2,
            type: "status" as const,
            at: "2026-05-29T00:00:02.000Z",
            status: "running" as const,
          },
          {
            sequence: 3,
            type: "error" as const,
            at: "2026-05-29T00:00:03.000Z",
            message: "resume failed",
          },
          {
            sequence: 4,
            type: "status" as const,
            at: "2026-05-29T00:00:04.000Z",
            status: "failed" as const,
          },
        ],
      };
      const api = {
        workflows: {
          resume: async () => ({
            runId: interruptedRun.id,
            status: "running" as const,
            result: null,
          }),
          getRun: async () => {
            getRunCalls += 1;
            return terminalFailedRun;
          },
        },
      };

      const view = render(
        <APIHarness client={api}>
          <ThemeProvider forcedTheme="dark">
            <TooltipProvider>
              <WorkflowRunToolCall
                args={{ name: "deep-research", args: {}, run_in_background: true }}
                status="completed"
                result={{
                  status: "interrupted",
                  runId: interruptedRun.id,
                  result: null,
                  run: interruptedRun,
                }}
              />
            </TooltipProvider>
          </ThemeProvider>
        </APIHarness>
      );

      fireEvent.click(view.getByRole("button", { name: "Resume workflow" }));

      await waitFor(() => expect(getRunCalls).toBe(1));
      const pendingIntervalHandler = intervalRef.handler;
      if (clearIntervalCalls === 0 && pendingIntervalHandler != null) {
        pendingIntervalHandler();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getRunCalls).toBe(1);
    } finally {
      globalThis.window.setInterval = originalSetInterval;
      globalThis.window.clearInterval = originalClearInterval;
    }
  });

  test("ignores duplicate checkpoint retry clicks while a retry request is in flight", async () => {
    let releaseRetry!: () => void;
    const retryStarted = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let retryCalls = 0;
    const failedRun = {
      id: "wfr_retry_duplicate",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:test",
      args: {},
      status: "failed" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "error" as const,
          at: "2026-05-29T00:00:00.000Z",
          message: "Execution interrupted",
        },
        {
          sequence: 2,
          type: "status" as const,
          at: "2026-05-29T00:00:01.000Z",
          status: "failed" as const,
        },
      ],
      steps: [],
    };
    const completedRun = {
      ...failedRun,
      status: "completed" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        ...failedRun.events,
        {
          sequence: 3,
          type: "result" as const,
          at: "2026-05-29T00:00:02.000Z",
          result: { reportMarkdown: "retried" },
        },
        {
          sequence: 4,
          type: "status" as const,
          at: "2026-05-29T00:00:02.000Z",
          status: "completed" as const,
        },
      ],
    };
    const api = {
      workflows: {
        retryFromCheckpoint: async () => {
          retryCalls += 1;
          await retryStarted;
          return { runId: failedRun.id, status: "running" as const, result: null };
        },
        getRun: async () => completedRun,
      },
    };
    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{ name: "deep-research", args: {}, run_in_background: true }}
              status="completed"
              result={{ status: "failed", runId: failedRun.id, result: null, run: failedRun }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    const retryButton = view.getByRole("button", { name: "Retry from checkpoint" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    await waitFor(() => expect(retryCalls).toBe(1));
    releaseRetry();
    await waitFor(() => expect(view.getAllByText("completed").length).toBeGreaterThan(0));
  });

  test("does not show retry from checkpoint for non-recoverable failed workflows", () => {
    const api = { workflows: { retryFromCheckpoint: async () => null } };
    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{ name: "deep-research", args: {}, run_in_background: true }}
              status="completed"
              result={{
                status: "failed",
                runId: "wfr_no_retry",
                result: null,
                run: {
                  id: "wfr_no_retry",
                  workspaceId: "workspace-1",
                  definition: {
                    name: "deep-research",
                    description: "Deep research",
                    scope: "built-in",
                    executable: true,
                  },
                  definitionSource: "export default function workflow() { return null; }",
                  definitionHash: "sha256:test",
                  args: {},
                  status: "failed",
                  createdAt: "2026-05-29T00:00:00.000Z",
                  updatedAt: "2026-05-29T00:00:01.000Z",
                  events: [
                    {
                      sequence: 1,
                      type: "error",
                      at: "2026-05-29T00:00:00.000Z",
                      message: "SyntaxError: Unexpected token",
                    },
                    {
                      sequence: 2,
                      type: "status",
                      at: "2026-05-29T00:00:01.000Z",
                      status: "failed",
                    },
                  ],
                  steps: [],
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    expect(view.queryByRole("button", { name: "Retry from checkpoint" })).toBeNull();
  });

  test("does not show retry from checkpoint for unfinished patch checkpoints", () => {
    const api = { workflows: { retryFromCheckpoint: async () => null } };
    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{ name: "deep-research", args: {}, run_in_background: true }}
              status="completed"
              result={{
                status: "failed",
                runId: "wfr_patch_no_retry",
                result: null,
                run: {
                  id: "wfr_patch_no_retry",
                  workspaceId: "workspace-1",
                  definition: {
                    name: "deep-research",
                    description: "Deep research",
                    scope: "built-in",
                    executable: true,
                  },
                  definitionSource: "export default function workflow() { return null; }",
                  definitionHash: "sha256:test",
                  args: {},
                  status: "failed",
                  createdAt: "2026-05-29T00:00:00.000Z",
                  updatedAt: "2026-05-29T00:00:01.000Z",
                  events: [
                    {
                      sequence: 1,
                      type: "patch",
                      at: "2026-05-29T00:00:00.000Z",
                      stepId: "apply-implement",
                      sourceTaskId: "task_impl",
                      status: "started",
                    },
                    {
                      sequence: 2,
                      type: "error",
                      at: "2026-05-29T00:00:00.500Z",
                      message: "Execution interrupted",
                    },
                    {
                      sequence: 3,
                      type: "status",
                      at: "2026-05-29T00:00:01.000Z",
                      status: "failed",
                    },
                  ],
                  steps: [],
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    expect(view.queryByRole("button", { name: "Retry from checkpoint" })).toBeNull();
  });

  test("clears resume polling and re-syncs the run snapshot when resume fails", async () => {
    let getRunCalls = 0;
    // A failed resume often means the card was stale (e.g. another agent already resumed the
    // run); the catch path re-fetches the run once so the card converges to the live record.
    const refreshedRun = {
      id: "wfr_resume_failed",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:test",
      args: { topic: "workflow cards" },
      status: "interrupted" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:00.000Z",
          status: "interrupted" as const,
        },
        {
          sequence: 2,
          type: "log" as const,
          at: "2026-05-29T00:00:02.000Z",
          message: "Trust gate blocked resume",
        },
      ],
      steps: [],
    };
    const api = {
      workflows: {
        resume: async () => {
          throw new Error("Project trust is required");
        },
        getRun: async () => {
          getRunCalls += 1;
          return refreshedRun;
        },
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "interrupted",
                runId: "wfr_resume_failed",
                result: null,
                run: {
                  id: "wfr_resume_failed",
                  workspaceId: "workspace-1",
                  definition: {
                    name: "deep-research",
                    description: "Deep research",
                    scope: "built-in",
                    executable: true,
                  },
                  definitionSource: "export default function workflow() { return null; }",
                  definitionHash: "sha256:test",
                  args: { topic: "workflow cards" },
                  status: "interrupted",
                  createdAt: "2026-05-29T00:00:00.000Z",
                  updatedAt: "2026-05-29T00:00:01.000Z",
                  events: [
                    {
                      sequence: 1,
                      type: "status",
                      at: "2026-05-29T00:00:00.000Z",
                      status: "interrupted",
                    },
                  ],
                  steps: [],
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    fireEvent.click(view.getByRole("button", { name: "Resume workflow" }));

    await waitFor(() => expect(view.getByText("Project trust is required")).toBeTruthy());
    // The best-effort getRun re-sync ran and its snapshot was applied to the card.
    await waitFor(() => expect(view.getByText("Trust gate blocked resume")).toBeTruthy());
    expect(getRunCalls).toBe(1);
    expect(view.getByText("Project trust is required")).toBeTruthy();
    // The pending-resume marker was cleared: the run is immediately resumable again and no
    // resume polling keeps hitting getRun after the failure.
    expect(view.getByRole("button", { name: "Resume workflow" })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getRunCalls).toBe(1);
  });

  test("saves scratch workflow runs directly to project workflows", async () => {
    const promotions: unknown[] = [];
    const api = {
      workflows: {
        promoteScratch: async (input: unknown) => {
          promotions.push(input);
          return {
            name: "scratch",
            description: "Scratch workflow",
            scope: "project",
            sourcePath: "/repo/.mux/workflows/scratch.js",
            executable: true,
          };
        },
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{ name: "scratch", args: {}, run_in_background: true }}
              status="completed"
              result={{
                status: "completed",
                runId: "wfr_scratch",
                result: { reportMarkdown: "scratch done" },
                run: {
                  id: "wfr_scratch",
                  workspaceId: "workspace-1",
                  definition: {
                    name: "scratch",
                    description: "Scratch workflow",
                    scope: "scratch",
                    executable: true,
                  },
                  definitionSource: "export default function workflow() { return null; }",
                  definitionHash: "sha256:test",
                  args: {},
                  status: "completed",
                  createdAt: "2026-05-29T00:00:00.000Z",
                  updatedAt: "2026-05-29T00:00:01.000Z",
                  events: [],
                  steps: [],
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    fireEvent.click(getWorkflowHeader(view));

    expect(view.queryByRole("button", { name: "Promote workflow" })).toBeNull();
    expect(view.getByRole("button", { name: "Save to global workflows" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Save to project workflows" }));

    await waitFor(() => expect(promotions).toHaveLength(1));
    expect(promotions[0]).toEqual({
      workspaceId: "workspace-1",
      runId: "wfr_scratch",
      name: "scratch",
      description: "Scratch workflow",
      location: "project",
      overwrite: false,
    });
    await waitFor(() => expect(view.getByText("Saved to project workflows")).toBeTruthy());
    expect(view.container.textContent).toContain("/repo/.mux/workflows/scratch.js");
    expect(view.queryByRole("button", { name: "Save to project workflows" })).toBeNull();
    expect(view.queryByRole("button", { name: "Save to global workflows" })).toBeNull();
  });

  test("saves scratch workflow runs directly to global workflows", async () => {
    const promotions: unknown[] = [];
    const api = {
      workflows: {
        promoteScratch: async (input: unknown) => {
          promotions.push(input);
          return {
            name: "scratch",
            description: "Scratch workflow",
            scope: "global",
            sourcePath: "/home/user/.mux/workflows/scratch.js",
            executable: true,
          };
        },
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{ name: "scratch", args: {}, run_in_background: true }}
              status="completed"
              result={{
                status: "completed",
                runId: "wfr_scratch",
                result: { reportMarkdown: "scratch done" },
                run: {
                  id: "wfr_scratch",
                  workspaceId: "workspace-1",
                  definition: {
                    name: "scratch",
                    description: "Scratch workflow",
                    scope: "scratch",
                    executable: true,
                  },
                  definitionSource: "export default function workflow() { return null; }",
                  definitionHash: "sha256:test",
                  args: {},
                  status: "completed",
                  createdAt: "2026-05-29T00:00:00.000Z",
                  updatedAt: "2026-05-29T00:00:01.000Z",
                  events: [],
                  steps: [],
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    fireEvent.click(getWorkflowHeader(view));

    fireEvent.click(view.getByRole("button", { name: "Save to global workflows" }));

    await waitFor(() => expect(promotions).toHaveLength(1));
    expect(promotions[0]).toEqual({
      workspaceId: "workspace-1",
      runId: "wfr_scratch",
      name: "scratch",
      description: "Scratch workflow",
      location: "global",
      overwrite: false,
    });
    await waitFor(() => expect(view.getByText("Saved to global workflows")).toBeTruthy());
    expect(view.container.textContent).toContain("/home/user/.mux/workflows/scratch.js");
    expect(view.queryByRole("button", { name: "Save to project workflows" })).toBeNull();
    expect(view.queryByRole("button", { name: "Save to global workflows" })).toBeNull();
  });

  test("uses live workflow run status for the header instead of stale tool completion state", () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{
              name: "deep-research",
              args: { topic: "workflow cards" },
              run_in_background: true,
            }}
            status="completed"
            result={{
              status: "running",
              runId: "wfr_running",
              result: null,
              run: {
                id: "wfr_running",
                workspaceId: "workspace-1",
                definition: {
                  name: "deep-research",
                  description: "Deep research",
                  scope: "built-in",
                  executable: true,
                },
                definitionSource: "export default function workflow() { return null; }",
                definitionHash: "sha256:test",
                args: { topic: "workflow cards" },
                status: "running",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:01.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "status",
                    at: "2026-05-29T00:00:00.000Z",
                    status: "running",
                  },
                  { sequence: 2, type: "phase", at: "2026-05-29T00:00:00.000Z", name: "scope" },
                ],
                steps: [],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    expect(view.getByText("executing")).toBeTruthy();
    expect(view.queryByText("completed")).toBeNull();
  });
});
