import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import type { WorkflowDefinitionDescriptor, WorkflowRunRecord } from "@/common/types/workflow";

import { WorkflowsTabView } from "./WorkflowsTab";
import {
  groupWorkflowDefinitionsByScope,
  summarizeWorkflowRuns,
} from "./workflowStatusPresentation";

function definition(
  name: string,
  scope: WorkflowDefinitionDescriptor["scope"]
): WorkflowDefinitionDescriptor {
  return { name, scope, description: `${name} workflow`, executable: true };
}

function run(overrides: Partial<WorkflowRunRecord>): WorkflowRunRecord {
  return {
    id: "wfr_test",
    workspaceId: "workspace-1",
    definition: definition("demo", "project"),
    definitionSource: "/repo/.mux/workflows/demo.js",
    definitionHash: "hash",
    args: {},
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    events: [],
    steps: [],
    ...overrides,
  };
}

function snapshot(input: {
  definitions?: WorkflowDefinitionDescriptor[];
  currentRuns?: WorkflowRunRecord[];
  historyRuns?: WorkflowRunRecord[];
}) {
  const definitions = input.definitions ?? [];
  const runs = [...(input.currentRuns ?? []), ...(input.historyRuns ?? [])];
  return {
    definitions,
    definitionGroups: groupWorkflowDefinitionsByScope(definitions),
    runs,
    currentRuns: input.currentRuns ?? [],
    historyRuns: input.historyRuns ?? [],
    summary: summarizeWorkflowRuns(runs),
    isLoading: false,
    error: null,
  };
}

describe("WorkflowsTabView", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders empty states without an API-backed snapshot", () => {
    const view = render(<WorkflowsTabView snapshot={snapshot({})} />);

    expect(view.getByText("No active workflows")).toBeTruthy();
    expect(view.getByText("No workflow definitions found")).toBeTruthy();
    expect(view.getByText("No workflow history yet")).toBeTruthy();
  });

  test("groups definitions by source scope and highlights runs needing attention first", () => {
    const view = render(
      <WorkflowsTabView
        snapshot={snapshot({
          definitions: [
            definition("project-flow", "project"),
            definition("global-flow", "global"),
            definition("built-in-flow", "built-in"),
            definition("scratch-flow", "scratch"),
          ],
          currentRuns: [
            run({
              id: "wfr_failed",
              status: "failed",
              definition: definition("project-flow", "project"),
            }),
            run({
              id: "wfr_running",
              status: "running",
              definition: definition("global-flow", "global"),
            }),
          ],
          historyRuns: [run({ id: "wfr_done", status: "completed" })],
        })}
      />
    );

    expect(view.getByText(/2 current/)).toBeTruthy();
    expect(view.getByText(/1 needs attention/)).toBeTruthy();
    for (const heading of ["Project", "Global", "Built-in", "Scratch"]) {
      expect(view.getByText(heading)).toBeTruthy();
    }
    expect(view.getAllByText("project-flow").length).toBeGreaterThan(0);
    expect(view.getAllByText("global-flow").length).toBeGreaterThan(0);
    expect(view.getAllByText("built-in-flow").length).toBeGreaterThan(0);
    expect(view.getAllByText("scratch-flow").length).toBeGreaterThan(0);
    expect(view.getByText("Recent history")).toBeTruthy();
  });

  test("offers foreground and background run actions", () => {
    const started: Array<{ name: string; runInBackground: boolean }> = [];
    const project = definition("project-flow", "project");
    const view = render(
      <WorkflowsTabView
        snapshot={snapshot({ definitions: [project] })}
        onRunDefinition={(definition, options) => {
          started.push({
            name: definition.name,
            runInBackground: options?.runInBackground === true,
          });
        }}
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Run project-flow" }));
    fireEvent.click(view.getByRole("button", { name: "Run project-flow in background" }));

    expect(started).toEqual([
      { name: "project-flow", runInBackground: false },
      { name: "project-flow", runInBackground: true },
    ]);
  });

  test("offers supported current-run actions", () => {
    const actions: Array<{ id: string; action: string }> = [];
    const running = run({
      id: "wfr_running",
      status: "running",
      definition: definition("running-flow", "project"),
    });
    const backgrounded = run({
      id: "wfr_backgrounded",
      status: "backgrounded",
      definition: definition("backgrounded-flow", "project"),
    });
    const interrupted = run({
      id: "wfr_interrupted",
      status: "interrupted",
      definition: definition("interrupted-flow", "project"),
    });
    const failed = run({
      id: "wfr_failed",
      status: "failed",
      definition: definition("failed-flow", "project"),
    });
    const completed = run({
      id: "wfr_completed",
      status: "completed",
      definition: definition("completed-flow", "project"),
    });
    const view = render(
      <WorkflowsTabView
        snapshot={snapshot({
          currentRuns: [running, backgrounded, interrupted, failed, completed],
        })}
        onRunAction={(run, action) => {
          actions.push({ id: run.id, action });
        }}
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Interrupt running-flow" }));
    fireEvent.click(view.getByRole("button", { name: "Interrupt backgrounded-flow" }));
    fireEvent.click(view.getByRole("button", { name: "Resume interrupted-flow" }));
    fireEvent.click(view.getByRole("button", { name: "Retry failed-flow" }));

    expect(view.queryByRole("button", { name: "Retry completed-flow" })).toBeNull();
    expect(actions).toEqual([
      { id: "wfr_running", action: "interrupt" },
      { id: "wfr_backgrounded", action: "interrupt" },
      { id: "wfr_interrupted", action: "resume" },
      { id: "wfr_failed", action: "retryFromCheckpoint" },
    ]);
  });

  test("offers promotion actions for scratch definitions", () => {
    const promoted: Array<{ name: string; location: "project" | "global" }> = [];
    const scratch = definition("scratch-flow", "scratch");
    const view = render(
      <WorkflowsTabView
        snapshot={snapshot({ definitions: [scratch] })}
        onPromoteScratchDefinition={(definition, location) => {
          promoted.push({ name: definition.name, location });
        }}
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Save scratch-flow to project workflows" }));
    fireEvent.click(view.getByRole("button", { name: "Save scratch-flow to global workflows" }));

    expect(promoted).toEqual([
      { name: "scratch-flow", location: "project" },
      { name: "scratch-flow", location: "global" },
    ]);
  });
});
