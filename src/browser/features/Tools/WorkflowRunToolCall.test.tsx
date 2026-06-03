/* eslint-disable @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
    expect(taskEventRow.className).toContain("cursor-pointer");
    expect(taskEventRow.getAttribute("title")).toBeNull();
    const taskEventSummary = taskEventRow.closest("summary");
    const taskEventDetails = taskEventRow.closest("details");
    if (taskEventSummary == null) {
      throw new Error("Expected task event summary");
    }
    expect(taskEventDetails?.hasAttribute("open")).toBe(false);

    fireEvent.click(taskEventSummary);

    expect(taskEventDetails?.hasAttribute("open")).toBe(true);
    await waitFor(
      () => expect(taskEventDetails?.textContent).toContain("Child task report body."),
      {
        timeout: 5_000,
      }
    );
    await waitFor(() => expect(view.container.textContent).toContain("Workflow result body"));
    const renderedText = view.container.textContent ?? "";
    expect(renderedText.indexOf("confidence")).toBeLessThan(
      renderedText.indexOf("Workflow result body")
    );
    expect(renderedText).toContain("confidence");
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
