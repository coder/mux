/**
 * Project and workspace configuration types.
 * Kept lightweight for preload script usage.
 */

import type { z } from "zod";
import type { ProjectConfigSchema, WorkspaceConfigSchema } from "../orpc/schemas";

export type Workspace = z.infer<typeof WorkspaceConfigSchema>;

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export interface ProjectsConfig {
  projects: Map<string, ProjectConfig>;
}
