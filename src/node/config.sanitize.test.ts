import { describe, it, expect } from "@jest/globals";
import * as path from "node:path";

import { sanitizeProjectsConfig } from "@/node/config";
import type { ProjectsConfig, Workspace } from "@/node/config";

const projectPath = "/tmp/mux-project";

function createConfig(workspaces: Workspace[]): ProjectsConfig {
  return {
    projects: new Map([[projectPath, { workspaces }]]),
  };
}

describe("sanitizeProjectsConfig", () => {
  it("repairs missing paths using projectPath + name", () => {
    const workspace: Workspace = { id: "w1", name: "feature", path: "" };
    const result = sanitizeProjectsConfig(createConfig([workspace]));
    const updated = result.config.projects.get(projectPath)!.workspaces[0];
    expect(updated.path).toBe(path.join(projectPath, "feature"));
    expect(result.summary.pathsRepaired).toBe(1);
    expect(result.summary.workspacesDropped).toBe(0);
  });

  it("drops workspaces with unrecoverable paths", () => {
    const workspace: Workspace = { id: "w2", path: "" };
    const result = sanitizeProjectsConfig(createConfig([workspace]));
    expect(result.config.projects.get(projectPath)!.workspaces).toHaveLength(0);
    expect(result.summary.workspacesDropped).toBe(1);
  });

  it("clears orphan parentWorkspaceId references", () => {
    const workspace: Workspace = {
      id: "child",
      name: "child",
      path: path.join(projectPath, "child"),
      parentWorkspaceId: "missing",
    };
    const result = sanitizeProjectsConfig(createConfig([workspace]));
    const updated = result.config.projects.get(projectPath)!.workspaces[0];
    expect(updated.parentWorkspaceId).toBeUndefined();
    expect(result.summary.orphanParentsCleared).toBe(1);
  });

  it("breaks parentWorkspaceId cycles", () => {
    const workspaceA: Workspace = {
      id: "a",
      name: "a",
      path: path.join(projectPath, "a"),
      parentWorkspaceId: "b",
    };
    const workspaceB: Workspace = {
      id: "b",
      name: "b",
      path: path.join(projectPath, "b"),
      parentWorkspaceId: "a",
    };
    const result = sanitizeProjectsConfig(createConfig([workspaceA, workspaceB]));
    const [updatedA, updatedB] = result.config.projects.get(projectPath)!.workspaces;
    expect(updatedA.parentWorkspaceId).toBeUndefined();
    expect(updatedB.parentWorkspaceId).toBeUndefined();
    expect(result.summary.cyclesBroken).toBe(1);
    expect(result.summary.cycleParentsCleared).toBe(2);
  });

  it("preserves unknown workspace keys", () => {
    const taskExperiments: Workspace["taskExperiments"] & { postCompactionContext: boolean } = {
      programmaticToolCalling: true,
      postCompactionContext: true,
    };
    const workspace: Workspace = {
      id: "w3",
      name: "task",
      path: path.join(projectPath, "task"),
      taskExperiments,
    };
    const result = sanitizeProjectsConfig(createConfig([workspace]));
    const updated = result.config.projects.get(projectPath)!.workspaces[0];
    const preserved = updated.taskExperiments as typeof taskExperiments | undefined;
    expect(preserved?.postCompactionContext).toBe(true);
  });
});
