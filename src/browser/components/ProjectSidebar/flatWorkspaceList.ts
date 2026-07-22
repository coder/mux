import type { GitHubRepoInfo } from "@/common/orpc/schemas/githubRepoInfo";
import type { ProjectConfig } from "@/common/types/project";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isMultiProject } from "@/common/utils/multiProject";
import { comparePinnedOrder, isWorkspacePinned } from "@/common/utils/pin";
import { getProjectDisplayName } from "@/common/utils/subProjects";
import { flattenWorkspaceTree } from "@/browser/utils/ui/workspaceFiltering";

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

function compareRoots(
  left: FrontendWorkspaceMetadata,
  right: FrontendWorkspaceMetadata,
  workspaceRecency: Record<string, number>
): number {
  const leftPinned = isWorkspacePinned(left);
  const rightPinned = isWorkspacePinned(right);
  if (leftPinned !== rightPinned) {
    return leftPinned ? -1 : 1;
  }
  if (leftPinned && rightPinned) {
    return comparePinnedOrder(left, right);
  }

  const recencyDelta = (workspaceRecency[right.id] ?? 0) - (workspaceRecency[left.id] ?? 0);
  if (recencyDelta !== 0) {
    return recencyDelta;
  }
  const createdAtDelta = Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? "");
  if (Number.isFinite(createdAtDelta) && createdAtDelta !== 0) {
    return createdAtDelta;
  }
  return left.id.localeCompare(right.id);
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

  const validRows = flattenWorkspaceTree(allRows);
  const validIds = new Set(validRows.map((workspace) => workspace.id));
  const childrenByParent = new Map<string, FrontendWorkspaceMetadata[]>();
  const roots: FrontendWorkspaceMetadata[] = [];
  for (const workspace of validRows) {
    const parentId = workspace.parentWorkspaceId;
    if (!parentId || !validIds.has(parentId)) {
      roots.push(workspace);
      continue;
    }
    const children = childrenByParent.get(parentId) ?? [];
    children.push(workspace);
    childrenByParent.set(parentId, children);
  }
  roots.sort((left, right) => compareRoots(left, right, params.workspaceRecency));

  const ordered: FrontendWorkspaceMetadata[] = [];
  const appendTree = (workspace: FrontendWorkspaceMetadata) => {
    ordered.push(workspace);
    for (const child of childrenByParent.get(workspace.id) ?? []) {
      appendTree(child);
    }
  };
  for (const root of roots) {
    appendTree(root);
  }

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
