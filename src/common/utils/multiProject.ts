import assert from "@/common/utils/assert";
import type { ProjectRef, WorkspaceMetadata } from "@/common/types/workspace";
import { PlatformPaths } from "@/common/utils/paths";

export function isMultiProject(ws: WorkspaceMetadata): boolean {
  return (ws.projects?.length ?? 0) > 1;
}

export function getProjects(ws: WorkspaceMetadata): ProjectRef[] {
  if (ws.projects && ws.projects.length > 0) return ws.projects;
  return [{ projectPath: ws.projectPath, projectName: ws.projectName }];
}

export function createProjectRefs(projectPaths: string[]): ProjectRef[] {
  assert(Array.isArray(projectPaths), "createProjectRefs requires a project path array");

  const usedProjectNames = new Set<string>();
  return projectPaths.map((projectPath) => {
    assert(typeof projectPath === "string", "createProjectRefs requires string project paths");
    const platformProjectName = PlatformPaths.getProjectName(projectPath);
    const baseProjectName =
      platformProjectName.includes("/") || platformProjectName.includes("\\")
        ? (projectPath
            .split(/[\\/]+/)
            .filter(Boolean)
            .at(-1) ?? platformProjectName)
        : platformProjectName;

    let projectName = baseProjectName;
    let suffix = 2;
    while (usedProjectNames.has(projectName)) {
      projectName = `${baseProjectName}-${suffix}`;
      suffix += 1;
    }

    assert(
      !projectName.includes("/") && !projectName.includes("\\"),
      `Project name must remain container-safe: ${projectName}`
    );
    usedProjectNames.add(projectName);

    return { projectPath, projectName };
  });
}
