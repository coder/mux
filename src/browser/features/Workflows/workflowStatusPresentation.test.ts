import { describe, expect, test } from "bun:test";

import type { WorkflowRunRecord } from "@/common/types/workflow";
import {
  compareWorkflowRunsForAttention,
  getLatestWorkflowRunSummary,
  getWorkflowStatusPresentation,
  summarizeWorkflowRuns,
} from "./workflowStatusPresentation";

function run(overrides: Partial<WorkflowRunRecord>): WorkflowRunRecord {
  return {
    id: "wfr_test",
    workspaceId: "workspace-1",
    definition: {
      name: "demo",
      description: "Demo workflow",
      scope: "project",
      executable: true,
      sourcePath: "/repo/.mux/workflows/demo.js",
    },
    definitionSource: "/repo/.mux/workflows/demo.js",
    definitionHash: "hash",
    args: {},
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    events: [],
    steps: [],
    ...overrides,
  };
}

describe("workflow status presentation", () => {
  test("aggregates active and problem runs with problem severity winning over activity", () => {
    const summary = summarizeWorkflowRuns([
      run({ id: "wfr_running", status: "running" }),
      run({ id: "wfr_failed", status: "failed" }),
      run({ id: "wfr_completed", status: "completed" }),
    ]);

    expect(summary.activeCount).toBe(1);
    expect(summary.problemCount).toBe(1);
    expect(summary.highestSeverity).toBe("error");
  });

  test("sorts failed and interrupted runs before live runs, then by most recent update", () => {
    const sorted = [
      run({ id: "wfr_old_running", status: "running", updatedAt: "2026-01-01T00:00:00.000Z" }),
      run({ id: "wfr_new_running", status: "running", updatedAt: "2026-01-03T00:00:00.000Z" }),
      run({ id: "wfr_interrupted", status: "interrupted", updatedAt: "2026-01-02T00:00:00.000Z" }),
      run({ id: "wfr_failed", status: "failed", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ].sort(compareWorkflowRunsForAttention);

    expect(sorted.map((item) => item.id)).toEqual([
      "wfr_failed",
      "wfr_interrupted",
      "wfr_new_running",
      "wfr_old_running",
    ]);
  });

  test("summarizes the latest meaningful event instead of status churn", () => {
    const summary = getLatestWorkflowRunSummary(
      run({
        events: [
          { sequence: 1, type: "status", at: "2026-01-01T00:00:00.000Z", status: "running" },
          { sequence: 2, type: "phase", at: "2026-01-01T00:00:01.000Z", name: "Collect inputs" },
          { sequence: 3, type: "log", at: "2026-01-01T00:00:02.000Z", message: "Fetched 3 items" },
        ],
      })
    );

    expect(summary).toBe("Fetched 3 items");
  });

  test("falls back safely for unrecognized persisted statuses", () => {
    const presentation = getWorkflowStatusPresentation("paused-by-old-build");

    expect(presentation.severity).toBe("unknown");
    expect(presentation.isActive).toBe(false);
    expect(presentation.needsAttention).toBe(false);
  });
});
