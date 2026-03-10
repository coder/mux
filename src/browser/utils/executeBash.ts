import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

interface WorkspaceRelativeProjectMatch {
  normalizedPath: string;
  repoRelativePath?: string;
  projectPath: string;
}

function resolveWorkspaceRelativeProjectMatch(
  workspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> | null | undefined,
  workspaceRelativePath: string | null | undefined
): WorkspaceRelativeProjectMatch | undefined {
  const projects = workspaceMetadata?.projects;
  if (!projects || projects.length < 2 || !workspaceRelativePath) {
    return undefined;
  }

  const normalizedPath = workspaceRelativePath.replaceAll("\\", "/").trim();
  if (!normalizedPath) {
    return undefined;
  }

  const firstSlashIndex = normalizedPath.indexOf("/");
  const projectName =
    firstSlashIndex === -1 ? normalizedPath : normalizedPath.slice(0, firstSlashIndex).trim();
  if (!projectName) {
    return undefined;
  }

  const project = projects.find((candidate) => candidate.projectName === projectName);
  if (!project?.projectPath) {
    return undefined;
  }

  const repoRelativePath =
    firstSlashIndex === -1
      ? undefined
      : normalizedPath.slice(firstSlashIndex + 1).trim() || undefined;

  return {
    normalizedPath,
    repoRelativePath,
    projectPath: project.projectPath,
  };
}

/**
 * Resolve the owning project for a workspace-relative path when a multi-project workspace exposes
 * each repo under a top-level project-name directory inside the shared container root.
 */
export function resolveRepoRootProjectPath(
  workspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> | null | undefined,
  workspaceRelativePath: string | null | undefined
): string | undefined {
  return resolveWorkspaceRelativeProjectMatch(workspaceMetadata, workspaceRelativePath)
    ?.projectPath;
}

/**
 * Repo-root git commands must strip any top-level sibling-project prefix once execution switches to
 * that repo checkout, otherwise git pathspecs like `project-b/src/file.ts` miss files under `src/`.
 */
export function normalizeRepoRootFilePath(
  workspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> | null | undefined,
  workspaceRelativePath: string | null | undefined,
  repoRootProjectPath?: string | null
): string {
  const normalizedRepoRootProjectPath = repoRootProjectPath?.trim();
  const match = resolveWorkspaceRelativeProjectMatch(workspaceMetadata, workspaceRelativePath);
  if (!normalizedRepoRootProjectPath || !match) {
    return workspaceRelativePath?.replaceAll("\\", "/") ?? "";
  }

  return match.projectPath === normalizedRepoRootProjectPath && match.repoRelativePath
    ? match.repoRelativePath
    : match.normalizedPath;
}

/**
 * Repo-context scripts must opt into repo-root execution so multi-project workspaces can keep
 * default script mode on the shared container root without regressing git/file viewers.
 * Path-targeted callers can also point repo-root execution at the owning project checkout.
 */
export function repoRootBashOptions(
  timeout_secs?: number,
  repoRootProjectPath?: string | null
): {
  timeout_secs?: number;
  cwdMode: "repo-root";
  repoRootProjectPath?: string;
} {
  const options =
    timeout_secs == null
      ? { cwdMode: "repo-root" as const }
      : { timeout_secs, cwdMode: "repo-root" as const };
  const normalizedProjectPath = repoRootProjectPath?.trim();
  return normalizedProjectPath
    ? { ...options, repoRootProjectPath: normalizedProjectPath }
    : options;
}
