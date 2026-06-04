/* eslint-disable @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";

import { APIContext } from "@/browser/contexts/API";
import {
  CommandRegistryProvider,
  useCommandRegistry,
  type CommandAction,
} from "@/browser/contexts/CommandRegistryContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { WorkflowRunToolCall } from "./WorkflowRunToolCall";

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
    expect(taskEventRow.closest('[role="button"]')?.className).toContain("cursor-pointer");
    expect(taskEventRow.getAttribute("title")).toBeNull();
    expect(taskEventRow.closest("summary")).toBeNull();
    const taskReportToggle = view.getByLabelText("Show report for task_scope");
    expect(taskReportToggle.closest('[role="button"]')).toBeNull();

    fireEvent.click(taskReportToggle);

    await waitFor(() => expect(view.container.textContent).toContain("Child task report body."), {
      timeout: 5_000,
    });
    await waitFor(() => expect(view.container.textContent).toContain("Workflow result body"));
    const renderedText = view.container.textContent ?? "";
    expect(renderedText.indexOf("confidence")).toBeLessThan(
      renderedText.indexOf("Workflow result body")
    );
    expect(renderedText).toContain("confidence");
  });

  test("coalesces task attempts, navigates rows, and toggles completed reports separately", async () => {
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
                    result: { reportMarkdown: "## Implement report\n\nCompleted task body." },
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

    fireEvent.click(view.getByText("implement / task_retry / started"));
    expect(navigatedTo).toEqual(["task_retry"]);

    const completedTaskControl = view
      .getByText("implement / task_live / completed")
      .closest('[role="button"]');
    if (completedTaskControl == null) {
      throw new Error("Expected completed task row to be keyboard focusable");
    }

    fireEvent.keyDown(completedTaskControl, { key: "Enter" });
    expect(navigatedTo).toEqual(["task_retry", "task_live"]);
    expect(view.container.textContent).not.toContain("Completed task body.");

    const reportToggle = view.getByLabelText("Show report for task_live");
    expect(reportToggle.closest('[role="button"]')).toBeNull();
    fireEvent.click(reportToggle);

    expect(navigatedTo).toEqual(["task_retry", "task_live"]);
    await waitFor(() => expect(view.container.textContent).toContain("Completed task body."));

    fireEvent.click(view.getByLabelText("Hide report for task_live"));
    expect(view.container.textContent).not.toContain("Completed task body.");
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

  test("clears resume polling when resume fails", async () => {
    let getRunCalls = 0;
    const api = {
      workflows: {
        resume: async () => {
          throw new Error("Project trust is required");
        },
        getRun: async () => {
          getRunCalls += 1;
          return null;
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getRunCalls).toBe(0);
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
