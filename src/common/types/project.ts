/**
 * Project and workspace configuration types.
 * Kept lightweight for preload script usage.
 */

import type { RuntimeConfig } from "./runtime";

/**
 * Workspace configuration in config.json.
 *
 * NEW FORMAT (preferred, used for all new workspaces):
 * {
 *   "path": "~/.mux/src/project/workspace-id",  // Kept for backward compat
 *   "id": "a1b2c3d4e5",                          // Stable workspace ID
 *   "name": "feature-branch",                    // User-facing name
 *   "createdAt": "2024-01-01T00:00:00Z",        // Creation timestamp
 *   "runtimeConfig": { ... }                     // Runtime config (local vs SSH)
 * }
 *
 * LEGACY FORMAT (old workspaces, still supported):
 * {
 *   "path": "~/.mux/src/project/workspace-id"   // Only field present
 * }
 *
 * For legacy entries, metadata is read from ~/.mux/sessions/{workspaceId}/metadata.json
 */
export interface Workspace {
  /** Absolute path to workspace directory - REQUIRED for backward compatibility */
  path: string;

  /** Stable workspace ID (10 hex chars for new workspaces) - optional for legacy */
  id?: string;

  /** Git branch / directory name (e.g., "feature-branch") - optional for legacy */
  name?: string;

  /** ISO 8601 creation timestamp - optional for legacy */
  createdAt?: string;

  /** Runtime configuration (local vs SSH) - optional, defaults to local */
  runtimeConfig?: RuntimeConfig;
}

export interface ProjectConfig {
  workspaces: Workspace[];
}

export interface ProjectsConfig {
  projects: Map<string, ProjectConfig>;
}
