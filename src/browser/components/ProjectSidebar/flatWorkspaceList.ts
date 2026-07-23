import type { GitHubRepoInfo } from "@/common/orpc/schemas/githubRepoInfo";
import type { ProjectConfig } from "@/common/types/project";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isMultiProject } from "@/common/utils/multiProject";
import { getProjectDisplayName } from "@/common/utils/subProjects";
import {
  compareWorkspacesByRecency,
  flattenWorkspaceTree,
  resolveEffectiveSectionId,
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

const EMPTY_SECTION_IDS: ReadonlySet<string> = new Set();

function buildSectionIdsByParent(
  userProjects: Map<string, ProjectConfig>
): Map<string, Set<string>> {
  const byParent = new Map<string, Set<string>>();
  for (const [projectPath, config] of userProjects) {
    if (!config.parentProjectPath) {
      continue;
    }
    const sectionIds = byParent.get(config.parentProjectPath) ?? new Set();
    sectionIds.add(projectPath);
    byParent.set(config.parentProjectPath, sectionIds);
  }
  return byParent;
}

function resolveProject(
  workspace: FrontendWorkspaceMetadata,
  userProjects: Map<string, ProjectConfig>,
  byId: ReadonlyMap<string, FrontendWorkspaceMetadata>,
  sectionIdsByParent: ReadonlyMap<string, ReadonlySet<string>>
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

  // Match the section renderer: honor subProjectPath only when it is a
  // configured sub-project and inherit it from the parent chain otherwise.
  const sectionIds = sectionIdsByParent.get(workspace.projectPath) ?? EMPTY_SECTION_IDS;
  const projectPath =
    resolveEffectiveSectionId(workspace, byId, sectionIds) ?? workspace.projectPath;
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

  const sectionIdsByParent = buildSectionIdsByParent(params.userProjects);
  return ordered.map((metadata) => {
    const project = resolveProject(metadata, params.userProjects, byId, sectionIdsByParent);
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
