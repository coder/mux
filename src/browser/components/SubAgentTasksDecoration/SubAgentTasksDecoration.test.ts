import { describe, expect, test } from "bun:test";

import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  collectDescendantSubAgents,
  getSubAgentStatusPresentation,
  isSubAgentActive,
} from "./SubAgentTasksDecoration";

function workspace(
  id: string,
  options: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id,
    name: id,
    projectName: "mux",
    projectPath: "/repo/mux",
    namedWorkspacePath: `/tmp/${id}`,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    ...options,
  };
}

describe("collectDescendantSubAgents", () => {
  test("returns persistent user-owned descendants while excluding archived and workflow tasks", () => {
    const workspaces = [
      workspace("parent"),
      workspace("running", { parentWorkspaceId: "parent", taskStatus: "running" }),
      workspace("completed", { parentWorkspaceId: "parent", taskStatus: "reported" }),
      workspace("nested", { parentWorkspaceId: "running", taskStatus: "reported" }),
      workspace("archived", {
        parentWorkspaceId: "parent",
        taskStatus: "reported",
        archivedAt: "2026-08-09T00:00:00.000Z",
      }),
      workspace("workflow", {
        parentWorkspaceId: "parent",
        taskStatus: "running",
        workflowTask: { runId: "run", stepId: "step" },
      }),
      workspace("workflow-child", { parentWorkspaceId: "workflow", taskStatus: "reported" }),
    ];

    expect(
      collectDescendantSubAgents(workspaces, "parent").map(({ workspace, depth }) => ({
        id: workspace.id,
        depth,
      }))
    ).toEqual([
      { id: "running", depth: 1 },
      { id: "nested", depth: 2 },
      { id: "completed", depth: 1 },
    ]);
  });

  test("classifies actionable base and continuation statuses as active", () => {
    expect(isSubAgentActive(workspace("queued", { taskStatus: "queued" }))).toBe(true);
    expect(isSubAgentActive(workspace("finishing", { taskStatus: "awaiting_report" }))).toBe(true);
    expect(
      isSubAgentActive(
        workspace("reawakened", { taskStatus: "reported", taskExecutionStatus: "running" })
      )
    ).toBe(true);
    expect(isSubAgentActive(workspace("reported", { taskStatus: "reported" }))).toBe(false);
    expect(isSubAgentActive(workspace("interrupted", { taskStatus: "interrupted" }))).toBe(false);
  });

  test("presents terminal continuation outcomes instead of the retained base report", () => {
    expect(
      getSubAgentStatusPresentation(
        workspace("completed", { taskStatus: "reported", taskExecutionStatus: "completed" })
      ).label
    ).toBe("Completed");
    expect(
      getSubAgentStatusPresentation(
        workspace("interrupted", { taskStatus: "reported", taskExecutionStatus: "interrupted" })
      ).label
    ).toBe("Interrupted");
    expect(
      getSubAgentStatusPresentation(
        workspace("failed", { taskStatus: "reported", taskExecutionStatus: "error" })
      ).label
    ).toBe("Failed");
  });
});
