import type { ProjectRef, WorkspaceMetadata } from "@/common/types/workspace";

export function isMultiProject(ws: WorkspaceMetadata): boolean {
  return (ws.projects?.length ?? 0) > 1;
}

export function getProjects(ws: WorkspaceMetadata): ProjectRef[] {
  if (ws.projects && ws.projects.length > 0) return ws.projects;
  return [{ projectPath: ws.projectPath, projectName: ws.projectName }];
}
