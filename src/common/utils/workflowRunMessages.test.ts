import { describe, expect, test } from "bun:test";

import type { WorkflowRunRecord } from "@/common/types/workflow";
import { buildWorkflowRunToolPart, stripWorkflowRunRecordForModel } from "./workflowRunMessages";

const run: WorkflowRunRecord = {
  id: "wfr_test",
  workspaceId: "workspace-1",
  workflow: {
    name: "nested-parent-simple",
    description: "Nested parent",
    scope: "project",
    executable: true,
  },
  source: "export default function workflow() { return { reportMarkdown: 'done' }; }",
  sourceHash: "sha256:test",
  args: {},
  status: "completed",
  createdAt: "2026-05-29T00:00:00.000Z",
  updatedAt: "2026-05-29T00:00:01.000Z",
  events: [],
  steps: [],
};

describe("workflowRunMessages", () => {
  test("strips large run snapshots from model-bound workflow tool outputs", () => {
    const stripped = stripWorkflowRunRecordForModel("workflow_run", {
      status: "completed",
      runId: run.id,
      result: { reportMarkdown: "done" },
      run,
    });

    expect(stripped).toEqual({
      status: "completed",
      runId: run.id,
      result: { reportMarkdown: "done" },
    });
  });

  test("preserves run snapshots in UI workflow card tool parts", () => {
    const part = buildWorkflowRunToolPart(
      { name: "nested-parent-simple", args: {} },
      { runId: run.id, status: "completed", result: { reportMarkdown: "done" }, run },
      1_000
    );

    expect(part.state).toBe("output-available");
    if (part.state !== "output-available") {
      throw new Error("Expected workflow run tool part to include output");
    }
    expect(part.output).toMatchObject({
      status: "completed",
      runId: run.id,
      run: { id: run.id },
    });
  });
});
