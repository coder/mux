import type { Config, ProjectsConfig } from "@/node/config";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";

interface TrustProjectResolutionInput {
  projectPath?: string | null;
  namedWorkspacePath?: string | null;
}

function normalizeProjectTrustPath(projectPath?: string | null): string | undefined {
  if (!projectPath) {
    return undefined;
  }

  return stripTrailingSlashes(projectPath);
}

export function resolveConfiguredProjectPathForTrust(
  projects: ProjectsConfig["projects"],
  input: TrustProjectResolutionInput
): string | undefined {
  const normalizedProjectPath = normalizeProjectTrustPath(input.projectPath);
  if (normalizedProjectPath && projects.has(normalizedProjectPath)) {
    return normalizedProjectPath;
  }

  const normalizedWorkspacePath = normalizeProjectTrustPath(input.namedWorkspacePath);
  if (normalizedWorkspacePath && projects.has(normalizedWorkspacePath)) {
    return normalizedWorkspacePath;
  }

  if (!normalizedWorkspacePath) {
    return undefined;
  }

  for (const [storedProjectPath, projectConfig] of projects) {
    const hasKnownWorkspacePath = projectConfig.workspaces.some(
      (workspace) => stripTrailingSlashes(workspace.path) === normalizedWorkspacePath
    );
    if (hasKnownWorkspacePath) {
      return storedProjectPath;
    }
  }

  return undefined;
}

/**
 * Repo-controlled configuration should only run or load after the user has
 * explicitly trusted the project.
 */
export function isProjectTrusted(
  config: Config,
  projectPath?: string | null,
  namedWorkspacePath?: string | null
): boolean {
  const projects = config.loadConfigOrDefault().projects;
  const resolvedProjectPath = resolveConfiguredProjectPathForTrust(projects, {
    projectPath,
    namedWorkspacePath,
  });

  return resolvedProjectPath ? (projects.get(resolvedProjectPath)?.trusted ?? false) : false;
}
