export interface WorkspaceConfigEntry {
  path: string;
  id?: string;
  name?: string;
  createdAt?: string;
  runtimeConfig?: Record<string, unknown>;
}

export interface ProjectConfig {
  workspaces: WorkspaceConfigEntry[];
}

export type ProjectsListResponse = Array<[string, ProjectConfig]>;
