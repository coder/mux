import { describe, expect, test } from "bun:test";

import type { WorkflowRunRecord } from "@/common/types/workflow";
import { getWorkflowRunRerunScriptPath } from "./WorkflowRunHeader";

function makeRun(workflow: WorkflowRunRecord["workflow"]): WorkflowRunRecord {
  return {
    id: "wfr_test",
    workspaceId: "workspace-1",
    workflow,
    source: "export default function workflow() { return null; }",
    sourceHash: "sha256:test",
    args: {},
    status: "completed",
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:01.000Z",
    events: [],
    steps: [],
  };
}

describe("getWorkflowRunRerunScriptPath", () => {
  test("returns path-based workflow script paths", () => {
    expect(
      getWorkflowRunRerunScriptPath(
        makeRun({
          name: "local-workflow",
          description: "Local workflow",
          scope: "project",
          sourcePath: "./workflows/local.js",
          sourceKind: "workspace-file",
          executable: true,
        })
      )
    ).toBe("./workflows/local.js");
  });

  test("does not treat inline workflow provenance paths as rerunnable script paths", () => {
    expect(
      getWorkflowRunRerunScriptPath(
        makeRun({
          name: "inline-abcdef123456",
          description: "Inline workflow",
          scope: "project",
          sourcePath: "inline://workflow-abcdef123456.js",
          requestedScriptPath: "inline://workflow-abcdef123456.js",
          canonicalScriptPath: "inline://workflow-abcdef123456.js",
          sourceKind: "inline",
          executable: true,
        })
      )
    ).toBeNull();

    expect(
      getWorkflowRunRerunScriptPath(
        makeRun({
          name: "legacy-inline",
          description: "Legacy inline provenance",
          scope: "project",
          sourcePath: "inline://workflow-deadbeef.js",
          executable: true,
        })
      )
    ).toBeNull();
  });
});
