import { describe, expect, it } from "bun:test";

import type { RuntimeConfig } from "@/common/types/runtime";
import {
  buildLegacyRemoteProjectLayout,
  buildRemoteProjectLayout,
  getRemoteWorkspacePath,
} from "@/node/runtime/remoteProjectLayout";
import {
  createRuntimeForWorkspaceProject,
  getWorkspacePathHintForProject,
  getWorkspaceProjectRepos,
  resolveWorkspacePathForProject,
} from "@/node/services/workspaceProjectRepos";

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

  it("reuses the persisted workspace path for the current SSH project when it matches a known project layout", () => {
    const runtimeConfig = {
      type: "ssh",
      host: "example.com",
      srcBaseDir: "/tmp/src",
    } as const;
    const primaryProjectPath = "/tmp/projects/main";
    const workspaceName = "main";
    const workspacePath = getRemoteWorkspacePath(
      buildLegacyRemoteProjectLayout(runtimeConfig.srcBaseDir, primaryProjectPath),
      workspaceName
    );
    const repos = getWorkspaceProjectRepos({
      workspaceId: "workspace-1",
      workspaceName,
      workspacePath,
      runtimeConfig,
      projectPath: primaryProjectPath,
      projectName: "main",
      projects: [
        { projectPath: primaryProjectPath, projectName: "main" },
        { projectPath: "/tmp/projects/other", projectName: "other" },
      ],
    });

    expect(repos[0]?.repoCwd).toBe(workspacePath);
  });

  it("recreates single-project SSH runtimes from the persisted workspace path", () => {
    const runtimeConfig = {
      type: "ssh",
      host: "example.com",
      srcBaseDir: "/tmp/src",
    } as const;
    const projectPath = "/tmp/projects/main";
    const workspaceName = "main";
    const workspacePath = getRemoteWorkspacePath(
      buildLegacyRemoteProjectLayout(runtimeConfig.srcBaseDir, projectPath),
      workspaceName
    );
    const runtime = createRuntimeForWorkspaceProject(
      {
        workspaceName,
        workspacePath,
        runtimeConfig,
        projectPath,
        projectName: "main",
      },
      projectPath
    );

    expect(runtime.getWorkspacePath(projectPath, workspaceName)).toBe(workspacePath);
    expect(
      resolveWorkspacePathForProject(
        {
          workspaceName,
          workspacePath,
          runtimeConfig,
          projectPath,
          projectName: "main",
        },
        projectPath,
        runtime
      )
    ).toBe(workspacePath);
  });

  it("resolves single-project paths without constructing a runtime", () => {
    expect(
      resolveWorkspacePathForProject(
        {
          workspaceName: "main",
          workspacePath: "/tmp/workspaces/main",
          runtimeConfig: { type: "made-up-runtime" } as unknown as RuntimeConfig,
          projectPath: "/tmp/projects/main",
          projectName: "main",
        },
        "/tmp/projects/main"
      )
    ).toBe("/tmp/workspaces/main");
  });

  it("resolves canonical sibling paths when a multi-project SSH workspace has no recognized layout hint", () => {
    const runtimeConfig = {
      type: "ssh",
      host: "example.com",
      srcBaseDir: "/tmp/src",
    } as const;
    const workspaceName = "main";
    const primaryProjectPath = "/tmp/projects/main";
    const secondaryProjectPath = "/tmp/projects/other";

    expect(
      resolveWorkspacePathForProject(
        {
          workspaceName,
          workspacePath: "/tmp/src/containers/main",
          runtimeConfig,
          projectPath: primaryProjectPath,
          projectName: "main",
          projects: [
            { projectPath: primaryProjectPath, projectName: "main" },
            { projectPath: secondaryProjectPath, projectName: "other" },
          ],
        },
        secondaryProjectPath
      )
    ).toBe(
      getRemoteWorkspacePath(
        buildRemoteProjectLayout(runtimeConfig.srcBaseDir, secondaryProjectPath),
        workspaceName
      )
    );
  });

  it("derives hashed SSH paths for secondary multi-project repos", () => {
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
      workspacePath: "/tmp/legacy/main",
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
        buildRemoteProjectLayout(runtimeConfig.srcBaseDir, secondaryProjectPath),
        workspaceName
      )
    );
  });

  it("derives legacy SSH path hints for sibling multi-project repos when the persisted root is legacy-shaped", () => {
    const runtimeConfig = {
      type: "ssh",
      host: "example.com",
      srcBaseDir: "/tmp/src",
    } as const;
    const primaryProjectPath = "/tmp/projects/main";
    const secondaryProjectPath = "/tmp/projects/other";
    const workspaceName = "main";

    const hint = getWorkspacePathHintForProject(
      {
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
      },
      secondaryProjectPath
    );

    expect(hint).toBe(
      getRemoteWorkspacePath(
        buildLegacyRemoteProjectLayout(runtimeConfig.srcBaseDir, secondaryProjectPath),
        workspaceName
      )
    );
  });

  it("returns no SSH path hint when the persisted root is not a project checkout", () => {
    const runtimeConfig = {
      type: "ssh",
      host: "example.com",
      srcBaseDir: "/tmp/src",
    } as const;
    const primaryProjectPath = "/tmp/projects/main";

    const hint = getWorkspacePathHintForProject(
      {
        workspaceName: "main",
        workspacePath: "/tmp/src/containers/main",
        runtimeConfig,
        projectPath: primaryProjectPath,
        projectName: "main",
        projects: [{ projectPath: primaryProjectPath, projectName: "main" }],
      },
      primaryProjectPath
    );

    expect(hint).toBeUndefined();
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
