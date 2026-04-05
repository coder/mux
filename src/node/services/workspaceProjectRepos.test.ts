import { describe, expect, it } from "bun:test";

import {
  buildLegacyRemoteProjectLayout,
  getRemoteWorkspacePath,
} from "@/node/runtime/remoteProjectLayout";
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

  it("reuses the persisted workspace path for the current SSH project in multi-project views", () => {
    const repos = getWorkspaceProjectRepos({
      workspaceId: "workspace-1",
      workspaceName: "main",
      workspacePath: "/tmp/legacy/main",
      runtimeConfig: {
        type: "ssh",
        host: "example.com",
        srcBaseDir: "/tmp/src",
      },
      projectPath: "/tmp/projects/main",
      projectName: "main",
      projects: [
        { projectPath: "/tmp/projects/main", projectName: "main" },
        { projectPath: "/tmp/projects/other", projectName: "other" },
      ],
    });

    expect(repos[0]?.repoCwd).toBe("/tmp/legacy/main");
  });

  it("derives persisted legacy SSH paths for secondary multi-project repos", () => {
    const runtimeConfig = {
      type: "ssh",
      host: "example.com",
      srcBaseDir: "/tmp/src",
    } as const;
    const workspaceName = "main";
    const primaryProjectPath = "/tmp/projects/main";
    const secondaryProjectPath = "/tmp/projects/other";
    const repos = getWorkspaceProjectRepos({
      workspaceId: "workspace-1",
      workspaceName,
      workspacePath: getRemoteWorkspacePath(
        buildLegacyRemoteProjectLayout(runtimeConfig.srcBaseDir, primaryProjectPath),
        workspaceName
      ),
      runtimeConfig,
      projectPath: primaryProjectPath,
      projectName: "main",
      projects: [
        { projectPath: primaryProjectPath, projectName: "main" },
        { projectPath: secondaryProjectPath, projectName: "other" },
      ],
    });

    expect(repos[1]?.repoCwd).toBe(
      getRemoteWorkspacePath(
        buildLegacyRemoteProjectLayout(runtimeConfig.srcBaseDir, secondaryProjectPath),
        workspaceName
      )
    );
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
