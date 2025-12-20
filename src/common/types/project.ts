/**
 * Project and workspace configuration types.
 * Kept lightweight for preload script usage.
 */

import type { z } from "zod";
import type {
  PersistedSettingsSchema,
  ProjectConfigSchema,
  WorkspaceConfigSchema,
} from "../orpc/schemas";

export type Workspace = z.infer<typeof WorkspaceConfigSchema>;

export type PersistedSettings = z.infer<typeof PersistedSettingsSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export type FeatureFlagOverride = "default" | "on" | "off";

export interface ProjectsConfig {
  /** Cross-client persisted settings (shared via ~/.mux/config.json). */
  persistedSettings?: PersistedSettings;
  projects: Map<string, ProjectConfig>;
  /** SSH hostname/alias for this machine (used for editor deep links in browser mode) */
  serverSshHost?: string;
  /** IDs of splash screens that have been viewed */
  viewedSplashScreens?: string[];
  /** Cross-client feature flag overrides (shared via ~/.mux/config.json). */
  featureFlagOverrides?: Record<string, FeatureFlagOverride>;
}
