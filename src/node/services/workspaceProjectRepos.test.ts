import { describe, expect, it } from "bun:test";

import { getWorkspaceProjectRepos } from "@/node/services/workspaceProjectRepos";

describe("getWorkspaceProjectRepos", () => {
  it("treats an empty project list as a single-project fallback", () => {
    const repos = getWorkspaceProjectRepos({
      workspaceId: "workspace-1",
      workspaceName: "main",
      workspacePath: "/tmp/workspaces/main",
      runtimeConfig: { type: "local" },
      projectPath: "/tmp/projects/main",
      projectName: "main",
      projects: [],
    });

    expect(repos).toEqual([
      {
        projectPath: "/tmp/projects/main",
        projectName: "main",
        storageKey: "main",
        repoCwd: "/tmp/workspaces/main",
      },
    ]);
  });
});
