import assert from "node:assert/strict";

import type { ProjectRef } from "@/common/types/workspace";
import type { RuntimeConfig } from "@/common/types/runtime";
import { PlatformPaths } from "@/common/utils/paths";
import { createRuntime } from "@/node/runtime/runtimeFactory";

export interface WorkspaceProjectRepo {
  projectPath: string;
  projectName: string;
  storageKey: string;
  repoCwd: string;
}

interface WorkspaceProjectRepoParams {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  runtimeConfig: RuntimeConfig;
  projectPath: string;
  projectName?: string;
  projects?: ProjectRef[];
}

export function getWorkspaceProjectRepos(
  params: WorkspaceProjectRepoParams
): WorkspaceProjectRepo[] {
  assert(
    params.workspaceId.trim().length > 0,
    "getWorkspaceProjectRepos: workspaceId must be non-empty"
  );
  assert(
    params.workspaceName.trim().length > 0,
    "getWorkspaceProjectRepos: workspaceName must be non-empty"
  );
  assert(
    params.workspacePath.trim().length > 0,
    "getWorkspaceProjectRepos: workspacePath must be non-empty"
  );
  assert(
    params.projectPath.trim().length > 0,
    "getWorkspaceProjectRepos: projectPath must be non-empty"
  );

  const trimmedProjectName = params.projectName?.trim();
  const primaryProjectName =
    trimmedProjectName && trimmedProjectName.length > 0
      ? trimmedProjectName
      : PlatformPaths.getProjectName(params.projectPath).trim();
  assert(
    primaryProjectName.length > 0,
    "getWorkspaceProjectRepos: primaryProjectName must be non-empty"
  );

  const orderedProjects =
    params.projects && params.projects.length > 0
      ? params.projects
      : ([
          {
            projectPath: params.projectPath,
            projectName: primaryProjectName,
          },
        ] satisfies ProjectRef[]);

  const expectedProjectCount =
    params.projects && params.projects.length > 0 ? params.projects.length : 1;
  assert(
    orderedProjects.length === expectedProjectCount,
    `getWorkspaceProjectRepos: expected ${expectedProjectCount} projects, got ${orderedProjects.length}`
  );

  const isMultiProject = orderedProjects.length > 1;
  const repos = orderedProjects.map((project) => {
    const projectName = project.projectName.trim();
    assert(projectName.length > 0, "getWorkspaceProjectRepos: projectName must be non-empty");

    const repoCwd = isMultiProject
      ? createRuntime(params.runtimeConfig, {
          projectPath: project.projectPath,
          workspaceName: params.workspaceName,
        }).getWorkspacePath(project.projectPath, params.workspaceName)
      : params.workspacePath;

    assert(
      repoCwd.trim().length > 0,
      `getWorkspaceProjectRepos: repoCwd missing for ${projectName}`
    );

    return {
      projectPath: project.projectPath,
      projectName,
      storageKey: projectName,
      repoCwd,
    } satisfies WorkspaceProjectRepo;
  });

  const storageKeys = repos.map((repo) => repo.storageKey);
  assert(
    new Set(storageKeys).size === storageKeys.length,
    `getWorkspaceProjectRepos: duplicate storage keys ${storageKeys.join(", ")}`
  );

  return repos;
}
