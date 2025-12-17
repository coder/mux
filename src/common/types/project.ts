/**
 * Project and workspace configuration types.
 * Kept lightweight for preload script usage.
 */

import type { z } from "zod";
import type {
  ProjectConfigSchema,
  WorkspaceConfigSchema,
  TaskSettingsSchema,
} from "../orpc/schemas";

export type Workspace = z.infer<typeof WorkspaceConfigSchema>;

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export type FeatureFlagOverride = "default" | "on" | "off";

export type TaskSettings = z.infer<typeof TaskSettingsSchema>;

export interface ProjectsConfig {
  projects: Map<string, ProjectConfig>;
  /** SSH hostname/alias for this machine (used for editor deep links in browser mode) */
  serverSshHost?: string;
  /** IDs of splash screens that have been viewed */
  viewedSplashScreens?: string[];
  /** Cross-client feature flag overrides (shared via ~/.mux/config.json). */
  featureFlagOverrides?: Record<string, FeatureFlagOverride>;
  /** Task settings for subagent workspaces */
  taskSettings?: TaskSettings;
}
