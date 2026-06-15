import type { Config } from "@/node/config";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";

/**
 * Repo-controlled configuration should only run or load after the user has
 * explicitly trusted the project.
 */
export function isProjectTrusted(config: Config, projectPath?: string | null): boolean {
  if (!projectPath) {
    return false;
  }

  const projects = config.loadConfigOrDefault().projects;
  const normalizedProjectPath = stripTrailingSlashes(projectPath);
  const project = projects.get(normalizedProjectPath);
  const trustOwnerPath = project?.parentProjectPath ?? normalizedProjectPath;
  return projects.get(trustOwnerPath)?.trusted ?? false;
}
