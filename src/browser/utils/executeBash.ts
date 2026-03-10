import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

/**
 * Resolve the owning project for a workspace-relative path when a multi-project workspace exposes
 * each repo under a top-level project-name directory inside the shared container root.
 */
export function resolveRepoRootProjectPath(
  workspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> | null | undefined,
  workspaceRelativePath: string | null | undefined
): string | undefined {
  const projects = workspaceMetadata?.projects;
  if (!projects || projects.length < 2 || !workspaceRelativePath) {
    return undefined;
  }

  const normalizedPath = workspaceRelativePath.replaceAll("\\", "/");
  const firstSlashIndex = normalizedPath.indexOf("/");
  const projectName =
    firstSlashIndex === -1
      ? normalizedPath.trim()
      : normalizedPath.slice(0, firstSlashIndex).trim();
  if (!projectName) {
    return undefined;
  }

  return projects.find((project) => project.projectName === projectName)?.projectPath;
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
