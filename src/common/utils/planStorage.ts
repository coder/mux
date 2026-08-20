/**
 * Default shux home directory for plan storage.
 * Uses tilde prefix for portability across local runtimes. Docker retains its
 * established /var/mux contract and passes that path explicitly.
 */
const DEFAULT_SHUX_HOME = "~/.shux";

/**
 * Get the plan file path for a workspace.
 * Returns a path that works with the specified runtime's shux home directory.
 *
 * Plan files are stored at: {shuxHome}/plans/{projectName}/{workspaceName}.md
 *
 * Workspace names include a random suffix (e.g., "sidebar-a1b2") making them
 * globally unique with high probability. The project folder is for organization
 * and discoverability, not uniqueness.
 *
 * @param workspaceName - Human-readable workspace name with suffix (e.g., "fix-plan-a1b2")
 * @param projectName - Project name extracted from the project path
 * @param shuxHome - Shux home directory (default: ~/.shux; Docker uses /var/mux)
 */
export function getPlanFilePath(
  workspaceName: string,
  projectName: string,
  shuxHome = DEFAULT_SHUX_HOME
): string {
  return `${shuxHome}/plans/${projectName}/${workspaceName}.md`;
}

/**
 * Get the legacy plan file path (stored by workspace ID).
 * Used for migration: when reading, check new path first, then fall back to legacy.
 * Rooted in the active runtime home so SSH (`~/.mux`) and Docker (`/var/mux`)
 * do not look at the local canonical `~/.shux` tree.
 *
 * @param workspaceId - Stable workspace identifier (e.g., "a1b2c3d4e5")
 * @param shuxHome - Runtime shux home (local ~/.shux, SSH ~/.mux, Docker /var/mux)
 */
export function getLegacyPlanFilePath(workspaceId: string, shuxHome: string): string {
  return `${shuxHome}/plans/${workspaceId}.md`;
}
