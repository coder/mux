import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import type { WorkflowDefinitionDescriptor, WorkflowRunRecord } from "@/common/types/workflow";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { WorkflowIndicatorPopoverContent, WorkflowIndicatorView } from "./WorkflowIndicator";
import {
  groupWorkflowDefinitionsByScope,
  summarizeWorkflowRuns,
} from "@/browser/features/Workflows/workflowStatusPresentation";

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

describe("WorkflowIndicatorView", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("prioritizes problem runs over active counts", () => {
    const definitions = [definition("project-flow", "project")];
    const runs = [
      run({ id: "wfr_failed", status: "failed", definition: definitions[0] }),
      run({ id: "wfr_running", status: "running" }),
    ];
    const view = render(
      <TooltipProvider>
        <WorkflowIndicatorView
          workspaceId="workspace-1"
          snapshot={{
            definitions,
            definitionGroups: groupWorkflowDefinitionsByScope(definitions),
            runs,
            currentRuns: runs,
            historyRuns: [],
            summary: summarizeWorkflowRuns(runs),
            isLoading: false,
            error: null,
          }}
        />
      </TooltipProvider>
    );

    const button = view.getByLabelText("1 workflow needs attention");
    expect(button.textContent).toContain("1");
  });

  test("uses plural grammar for multiple problem runs", () => {
    const failed = run({ id: "wfr_failed", status: "failed" });
    const interrupted = run({ id: "wfr_interrupted", status: "interrupted" });
    const runs = [failed, interrupted];
    const view = render(
      <TooltipProvider>
        <WorkflowIndicatorView
          workspaceId="workspace-1"
          snapshot={{
            definitions: [],
            definitionGroups: groupWorkflowDefinitionsByScope([]),
            runs,
            currentRuns: runs,
            historyRuns: [],
            summary: summarizeWorkflowRuns(runs),
            isLoading: false,
            error: null,
          }}
        />
      </TooltipProvider>
    );

    expect(view.getByLabelText("2 workflows need attention")).toBeTruthy();
  });

  test("opens the workflows tab from the popover action", () => {
    let opened = false;
    const view = render(
      <WorkflowIndicatorPopoverContent
        onOpenWorkflowsTab={() => {
          opened = true;
        }}
        snapshot={{
          definitions: [],
          definitionGroups: groupWorkflowDefinitionsByScope([]),
          runs: [],
          currentRuns: [],
          historyRuns: [],
          summary: summarizeWorkflowRuns([]),
          isLoading: false,
          error: null,
        }}
      />
    );

    fireEvent.click(view.getByText("Open tab"));

    expect(opened).toBe(true);
  });
});
