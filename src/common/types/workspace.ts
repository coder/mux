import { z } from "zod";

/**
 * Zod schema for workspace metadata validation
 */
export const WorkspaceMetadataSchema = z.object({
  id: z.string().min(1, "Workspace ID is required"),
  name: z.string().min(1, "Workspace name is required"),
  projectName: z.string().min(1, "Project name is required"),
  projectPath: z.string().min(1, "Project path is required"),
  createdAt: z.string().optional(), // ISO 8601 timestamp (optional for backward compatibility)
  // Legacy field - ignored on load, removed on save
  workspacePath: z.string().optional(),
});

/**
 * Unified workspace metadata type used throughout the application.
 * This is the single source of truth for workspace information.
 *
 * ID vs Name:
 * - `id`: Stable unique identifier (10 hex chars for new workspaces, legacy format for old)
 *   Generated once at creation, never changes
 * - `name`: User-facing mutable name (e.g., "feature-branch")
 *   Can be changed via rename operation
 *
 * For legacy workspaces created before stable IDs:
 * - id and name are the same (e.g., "mux-stable-ids")
 * For new workspaces:
 * - id is a random 10 hex char string (e.g., "a1b2c3d4e5")
 * - name is the branch/workspace name (e.g., "feature-branch")
 *
 * Path handling:
 * - Worktree paths are computed on-demand via config.getWorkspacePath(projectPath, name)
 * - Directory name uses workspace.name (the branch name)
 * - This avoids storing redundant derived data
 */
import type { RuntimeConfig } from "./runtime";

export interface WorkspaceMetadata {
  /** Stable unique identifier (10 hex chars for new workspaces, legacy format for old) */
  id: string;

  /** Git branch / directory name (e.g., "feature-branch") - used for path computation */
  name: string;

  /** Project name extracted from project path (for display) */
  projectName: string;

  /** Absolute path to the project (needed to compute workspace path) */
  projectPath: string;

  /** ISO 8601 timestamp of when workspace was created (optional for backward compatibility) */
  createdAt?: string;

  /** Runtime configuration for this workspace (always set, defaults to local on load) */
  runtimeConfig: RuntimeConfig;
}

/**
 * Git status for a workspace (ahead/behind relative to origin's primary branch)
 */
export interface GitStatus {
  ahead: number;
  behind: number;
  /** Whether there are uncommitted changes (staged or unstaged) */
  dirty: boolean;
}

/**
 * Frontend workspace metadata enriched with computed paths.
 * Backend computes these paths to avoid duplication of path construction logic.
 * Follows naming convention: Backend types vs Frontend types.
 */
export interface FrontendWorkspaceMetadata extends WorkspaceMetadata {
  /** Worktree path (uses workspace name as directory) */
  namedWorkspacePath: string;
}

export interface WorkspaceActivitySnapshot {
  /** Unix ms timestamp of last user interaction */
  recency: number;
  /** Whether workspace currently has an active stream */
  streaming: boolean;
  /** Last model sent from this workspace */
  lastModel: string | null;
}

/**
 * @deprecated Use FrontendWorkspaceMetadata instead
 */
export type WorkspaceMetadataWithPaths = FrontendWorkspaceMetadata;
