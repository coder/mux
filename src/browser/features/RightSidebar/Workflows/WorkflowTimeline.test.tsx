import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

import { installDom } from "../../../../../tests/ui/dom";
void mock.module("@/browser/features/Tools/WorkflowToolShared", () => ({
  WorkflowJsonBlock: (props: { value: unknown; ariaLabel: string }) => (
    <pre aria-label={props.ariaLabel}>{JSON.stringify(props.value)}</pre>
  ),
}));

let workflowTaskWorkspaces = new Map<string, FrontendWorkspaceMetadata>();
let navigateToWorkspace: (workspaceId: string) => void = () => undefined;
const workspaceStoreSubscribers = new Set<() => void>();

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  useWorkspaceStoreRaw: () => ({
    subscribeDerived: (listener: () => void) => {
      workspaceStoreSubscribers.add(listener);
      return () => workspaceStoreSubscribers.delete(listener);
    },
    getWorkspaceMetadata: (workspaceId: string) => workflowTaskWorkspaces.get(workspaceId),
    navigateToWorkspace: (workspaceId: string) => navigateToWorkspace(workspaceId),
  }),
}));

import type { WorkflowRunView } from "./projectWorkflowRun";
import { WorkflowTimeline } from "./WorkflowTimeline";

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

function syncWorkflowTaskWorkspaces(nextWorkspaces: Map<string, FrontendWorkspaceMetadata>): void {
  workflowTaskWorkspaces = nextWorkspaces;
  for (const subscriber of workspaceStoreSubscribers) {
    subscriber();
  }
}

function normalizeText(element: Element): string {
  return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function makeCompletedView(): WorkflowRunView {
  const timestamp = "2026-06-25T12:00:00.000Z";
  return {
    id: "wfr_test",
    workflow: {
      name: "test-workflow",
      description: "Test workflow",
      scope: "project",
      executable: true,
    },
    status: "completed",
    argEntries: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    phases: [],
    steps: [],
    result: {
      reportMarkdown: "",
      structuredOutput: {
        outcome: "converged",
        verifierRuns: 1,
        nested: { ignored: true },
      },
    },
    errorMessage: null,
    stats: {
      total: 0,
      done: 0,
      running: 0,
      failed: 0,
      elapsedMs: 0,
    },
  };
}

function makeRunningStepView(taskId: string): WorkflowRunView {
  const timestamp = "2026-06-25T12:00:00.000Z";
  return {
    ...makeCompletedView(),
    status: "running",
    phases: [
      {
        name: "implementation",
        label: "Implementation",
        steps: [
          {
            stepId: "implement",
            taskId,
            status: "running",
            title: "Implement #160",
            phaseName: "implementation",
            startedAt: timestamp,
          },
        ],
        done: 0,
        total: 1,
        running: true,
        failed: false,
      },
    ],
    steps: [],
    result: null,
    stats: {
      total: 1,
      done: 0,
      running: 1,
      failed: 0,
      elapsedMs: 0,
    },
  };
}

function makeCompletedStepView(taskId: string): WorkflowRunView {
  const startedAt = "2026-06-25T12:00:00.000Z";
  const completedAt = "2026-06-25T12:00:02.000Z";
  return {
    ...makeCompletedView(),
    phases: [
      {
        name: "review",
        label: "Review",
        steps: [
          {
            stepId: "review",
            taskId,
            status: "completed",
            title: "Review implementation",
            phaseName: "review",
            startedAt,
            completedAt,
            durationMs: 2000,
            result: {
              title: "Review result",
              reportMarkdown: "Completed step report body.",
            },
          },
        ],
        done: 1,
        total: 1,
        running: false,
        failed: false,
      },
    ],
    steps: [],
    result: null,
    stats: {
      total: 1,
      done: 1,
      running: 0,
      failed: 0,
      elapsedMs: 2000,
    },
  };
}

describe("WorkflowTimeline", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    navigateToWorkspace = () => undefined;
    syncWorkflowTaskWorkspaces(new Map());
    workspaceStoreSubscribers.clear();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("opens an available child task workspace from a workflow step", () => {
    const navigatedTo: string[] = [];
    navigateToWorkspace = (workspaceId) => {
      navigatedTo.push(workspaceId);
    };
    syncWorkflowTaskWorkspaces(
      new Map([["task_live", createWorkflowTaskWorkspaceMetadata("task_live")]])
    );

    const view = render(<WorkflowTimeline view={makeRunningStepView("task_live")} />);

    fireEvent.click(view.getByRole("button", { name: "Implementation 0/1" }));
    fireEvent.click(
      view.getByRole("button", { name: "Open workspace for workflow step Implement #160" })
    );

    expect(navigatedTo).toEqual(["task_live"]);
  });

  test("hides child task workspace action when workspace metadata is missing", () => {
    const view = render(<WorkflowTimeline view={makeRunningStepView("task_deleted")} />);

    fireEvent.click(view.getByRole("button", { name: "Implementation 0/1" }));

    expect(
      view.queryByRole("button", { name: "Open workspace for workflow step Implement #160" })
    ).toBeNull();
  });

  test("opens completed step details independently from workspace navigation", () => {
    const navigatedTo: string[] = [];
    navigateToWorkspace = (workspaceId) => {
      navigatedTo.push(workspaceId);
    };
    syncWorkflowTaskWorkspaces(
      new Map([["task_completed", createWorkflowTaskWorkspaceMetadata("task_completed")]])
    );
    const view = render(<WorkflowTimeline view={makeCompletedStepView("task_completed")} />);

    fireEvent.click(view.getByRole("button", { name: "Review 1/1" }));
    expect(view.queryByText("Completed step report body.")).toBeNull();

    fireEvent.click(
      view.getByRole("button", { name: "Open workspace for workflow step Review implementation" })
    );

    expect(navigatedTo).toEqual(["task_completed"]);
    expect(view.queryByText("Completed step report body.")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Review implementation 2s" }));

    expect(view.getByText("Completed step report body.")).toBeDefined();
  });

  test("renders final report stat chips as bold key before value", () => {
    const { container } = render(<WorkflowTimeline view={makeCompletedView()} />);

    const statTexts = Array.from(container.querySelectorAll("span"), normalizeText);
    const boldTexts = Array.from(container.querySelectorAll("b"), normalizeText);

    expect(statTexts).toContain("outcome converged");
    expect(statTexts).toContain("verifierRuns 1");
    expect(statTexts).not.toContain("converged outcome");
    expect(statTexts).not.toContain("1 verifierRuns");
    expect(boldTexts).toEqual(["outcome", "verifierRuns"]);
  });
});
