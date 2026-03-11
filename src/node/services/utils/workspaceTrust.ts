import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import type { ProjectsConfig } from "@/common/types/project";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";

export function isWorkspaceTrustedForSharedExecution(
  metadata: WorkspaceMetadata,
  projectsConfig: ProjectsConfig["projects"]
): boolean {
  if (!isMultiProject(metadata)) {
    return projectsConfig.get(stripTrailingSlashes(metadata.projectPath))?.trusted ?? false;
  }

  // Multi-project workspaces share a single runtime/container, so one untrusted repo must disable
  // trusted behavior for the whole execution environment.
  return getProjects(metadata).every(
    (project) => projectsConfig.get(stripTrailingSlashes(project.projectPath))?.trusted ?? false
  );
}
