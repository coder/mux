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

  it("sanitizes storage keys derived from malformed project names", () => {
    const repos = getWorkspaceProjectRepos({
      workspaceId: "workspace-1",
      workspaceName: "main",
      workspacePath: "/tmp/workspaces/main",
      runtimeConfig: { type: "local" },
      projectPath: "/tmp/projects/main",
      projectName: "../../secrets",
      projects: [],
    });

    expect(repos[0]?.storageKey).toBe("..-..-secrets");
  });

  it("disambiguates storage keys when sanitized project names collide", () => {
    const repos = getWorkspaceProjectRepos({
      workspaceId: "workspace-1",
      workspaceName: "main",
      workspacePath: "/tmp/workspaces/main",
      runtimeConfig: { type: "local" },
      projectPath: "/tmp/projects/main",
      projectName: "main",
      projects: [
        { projectPath: "/tmp/projects/api-core", projectName: "api:core" },
        { projectPath: "/tmp/projects/api-core-alt", projectName: "api?core" },
      ],
    });

    expect(repos.map((repo) => repo.storageKey)).toEqual(["api-core", "api-core-2"]);
  });
});
