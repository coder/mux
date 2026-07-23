import type { GitHubRepoInfo } from "@/common/orpc/schemas/githubRepoInfo";
import type { ProjectConfig } from "@/common/types/project";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isMultiProject } from "@/common/utils/multiProject";
import { getProjectDisplayName } from "@/common/utils/subProjects";
import {
  compareWorkspacesByRecency,
  flattenWorkspaceTree,
} from "@/browser/utils/ui/workspaceFiltering";

export interface FlatWorkspaceRow {
  metadata: FrontendWorkspaceMetadata;
  projectPath: string | null;
  projectName: string;
  githubRepoInfo: GitHubRepoInfo | null;
}

interface BuildFlatWorkspaceListParams {
  sortedWorkspacesByProject: Map<string, FrontendWorkspaceMetadata[]>;
  workspaceRecency: Record<string, number>;
  userProjects: Map<string, ProjectConfig>;
  githubRepoInfoByProject: Record<string, GitHubRepoInfo | null>;
  multiProjectWorkspacesEnabled: boolean;
}

function resolveProject(
  workspace: FrontendWorkspaceMetadata,
  userProjects: Map<string, ProjectConfig>
): { projectPath: string | null; projectName: string } {
  if (workspace.kind === "scratch") {
    return { projectPath: null, projectName: "Scratch" };
  }
  if (isMultiProject(workspace)) {
    const primary = workspace.projects?.[0];
    return {
      projectPath: primary?.projectPath ?? workspace.projectPath,
      projectName: primary?.projectName ?? workspace.projectName,
    };
  }

  const projectPath = workspace.subProjectPath ?? workspace.projectPath;
  return {
    projectPath,
    projectName: getProjectDisplayName(projectPath, userProjects.get(projectPath)),
  };
}

export function buildFlatWorkspaceList(params: BuildFlatWorkspaceListParams): FlatWorkspaceRow[] {
  const allRows: FrontendWorkspaceMetadata[] = [];
  const byId = new Map<string, FrontendWorkspaceMetadata>();
  for (const workspaces of params.sortedWorkspacesByProject.values()) {
    for (const workspace of workspaces) {
      if (byId.has(workspace.id)) {
        continue;
      }
      if (isMultiProject(workspace) && !params.multiProjectWorkspacesEnabled) {
        continue;
      }
      byId.set(workspace.id, workspace);
      allRows.push(workspace);
    }
  }

  const ordered = flattenWorkspaceTree(allRows, (left, right) =>
    compareWorkspacesByRecency(left, right, params.workspaceRecency)
  );

  return ordered.map((metadata) => {
    const project = resolveProject(metadata, params.userProjects);
    return {
      metadata,
      ...project,
      githubRepoInfo:
        project.projectPath == null
          ? null
          : (params.githubRepoInfoByProject[project.projectPath] ?? null),
    };
  });
}
