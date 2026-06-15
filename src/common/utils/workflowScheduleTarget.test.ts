import { describe, expect, test } from "bun:test";
import {
  getRuntimeConfigForScheduledNewWorkspaceTarget,
  getWorkflowScheduleNewWorkspaceTargetUnavailableReason,
} from "./workflowScheduleTarget";

describe("workflow schedule target helpers", () => {
  test("rejects unsupported fresh target source shapes", () => {
    expect(
      getWorkflowScheduleNewWorkspaceTargetUnavailableReason({
        projects: [
          { projectPath: "/repo/a", projectName: "a" },
          { projectPath: "/repo/b", projectName: "b" },
        ],
      })
    ).toContain("multi-project workspaces");

    expect(
      getWorkflowScheduleNewWorkspaceTargetUnavailableReason({ runtimeConfig: { type: "local" } })
    ).toContain("project-dir local workspaces");

    expect(
      getWorkflowScheduleNewWorkspaceTargetUnavailableReason({
        runtimeConfig: {
          type: "ssh",
          host: "coder://",
          srcBaseDir: "/home/coder/.mux/src",
          coder: { workspaceName: "existing-vm", existingWorkspace: true },
        },
      })
    ).toContain("existing Coder workspaces");
  });

  test("sanitizes template-backed Coder runtime identity for fresh scheduled targets", () => {
    const runtimeConfig = {
      type: "ssh" as const,
      host: "coder://",
      srcBaseDir: "/home/coder/.mux/src",
      coder: {
        workspaceName: "source-vm",
        template: "node",
        templateOrg: "coder",
        preset: "default",
      },
    };

    expect(getRuntimeConfigForScheduledNewWorkspaceTarget(runtimeConfig)).toEqual({
      type: "ssh",
      host: "coder://",
      srcBaseDir: "/home/coder/.mux/src",
      coder: {
        template: "node",
        templateOrg: "coder",
        preset: "default",
      },
    });
    expect(runtimeConfig.coder.workspaceName).toBe("source-vm");
  });
});
