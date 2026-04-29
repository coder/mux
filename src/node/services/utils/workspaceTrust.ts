import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import type { ProjectsConfig } from "@/common/types/project";
import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { resolveConfiguredProjectPathForTrust } from "@/node/utils/projectTrust";

export function isWorkspaceTrustedForSharedExecution(
  metadata: WorkspaceMetadata | FrontendWorkspaceMetadata,
  projectsConfig: ProjectsConfig["projects"]
): boolean {
  if (!isMultiProject(metadata)) {
    const resolvedProjectPath = resolveConfiguredProjectPathForTrust(projectsConfig, {
      projectPath: metadata.projectPath,
      namedWorkspacePath:
        "namedWorkspacePath" in metadata ? metadata.namedWorkspacePath : undefined,
    });
    return resolvedProjectPath
      ? (projectsConfig.get(resolvedProjectPath)?.trusted ?? false)
      : false;
  }

  // Multi-project workspaces share a single runtime/container, so one untrusted repo must disable
  // trusted behavior for the whole execution environment.
  return getProjects(metadata).every(
    (project) => projectsConfig.get(stripTrailingSlashes(project.projectPath))?.trusted ?? false
  );
}
