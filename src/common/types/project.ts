/**
 * Project and workspace configuration types.
 * Kept lightweight for preload script usage.
 */

import type { z } from "zod";
import type { ProjectConfigSchema, WorkspaceConfigSchema } from "../orpc/schemas";
import type { TaskSettings, SubagentAiDefaults } from "./tasks";

export type Workspace = z.infer<typeof WorkspaceConfigSchema>;

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export type FeatureFlagOverride = "default" | "on" | "off";

export interface ProjectsConfig {
  projects: Map<string, ProjectConfig>;
  /**
   * Bind host/interface for the desktop HTTP/WS API server.
   *
   * When unset, mux binds to 127.0.0.1 (localhost only).
   * When set to 0.0.0.0 or ::, mux can be reachable from other devices on your LAN/VPN.
   */
  apiServerBindHost?: string;
  /**
   * Port for the desktop HTTP/WS API server.
   *
   * When unset, mux binds to port 0 (random available port).
   */
  apiServerPort?: number;
  /**
   * When true, the desktop HTTP server also serves the mux web UI at /.
   *
   * This enables other devices (LAN/VPN) to open mux in a browser.
   */
  apiServerServeWebUi?: boolean;
  /** SSH hostname/alias for this machine (used for editor deep links in browser mode) */
  serverSshHost?: string;
  /** IDs of splash screens that have been viewed */
  viewedSplashScreens?: string[];
  /** Cross-client feature flag overrides (shared via ~/.mux/config.json). */
  featureFlagOverrides?: Record<string, FeatureFlagOverride>;
  /** Global task settings (agent sub-workspaces, queue limits, nesting depth) */
  taskSettings?: TaskSettings;
  /** Per-subagent default model + thinking overrides. Missing values inherit from the parent workspace. */
  subagentAiDefaults?: SubagentAiDefaults;
}
