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

  return (
    config.loadConfigOrDefault().projects.get(stripTrailingSlashes(projectPath))?.trusted ?? false
  );
}
