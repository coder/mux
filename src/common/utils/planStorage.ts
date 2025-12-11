/**
 * Mux home directory for plan storage.
 * Uses tilde prefix for portability across local/remote runtimes.
 * Note: Plan files intentionally do NOT use the -dev suffix because they
 * should be accessible regardless of whether running dev or prod builds.
 */
const MUX_HOME = "~/.mux";

/**
 * Get the plan file path for a workspace.
 * Returns a path with ~ prefix that works with both local and SSH runtimes.
 * The runtime will expand ~ to the appropriate home directory.
 *
 * Plan files are stored at: ~/.mux/plans/{projectName}/{workspaceName}.md
 *
 * Workspace names include a random suffix (e.g., "sidebar-a1b2") making them
 * globally unique with high probability. The project folder is for organization
 * and discoverability, not uniqueness.
 *
 * @param workspaceName - Human-readable workspace name with suffix (e.g., "fix-plan-a1b2")
 * @param projectName - Project name extracted from project path (e.g., "mux")
 */
export function getPlanFilePath(workspaceName: string, projectName: string): string {
  return `${MUX_HOME}/plans/${projectName}/${workspaceName}.md`;
}

/**
 * Get the legacy plan file path (stored by workspace ID).
 * Used for migration: when reading, check new path first, then fall back to legacy.
 *
 * @param workspaceId - Stable workspace identifier (e.g., "a1b2c3d4e5")
 */
export function getLegacyPlanFilePath(workspaceId: string): string {
  return `${MUX_HOME}/plans/${workspaceId}.md`;
}
