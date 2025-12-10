/**
 * Create a short hash from a string (for project path disambiguation).
 * Uses a simple djb2-like hash algorithm suitable for browser and Node.js.
 */
function shortHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  // Convert to unsigned 32-bit and take first 6 hex characters
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

/**
 * Get the plan file path for a workspace.
 * Returns a path with ~ prefix that works with both local and SSH runtimes.
 * The runtime will expand ~ to the appropriate home directory.
 *
 * Plan files are stored at: ~/.mux/plans/{projectName}-{pathHash}/{workspaceName}.md
 *
 * The pathHash is derived from the full project path to avoid collisions between
 * projects with the same basename (e.g., ~/work/mux vs ~/tmp/mux).
 *
 * @param workspaceName - Human-readable workspace name (e.g., "fix-plan-mode")
 * @param projectName - Project name extracted from project path (e.g., "mux")
 * @param projectPath - Full project path for disambiguation (e.g., "/home/user/mux")
 */
export function getPlanFilePath(
  workspaceName: string,
  projectName: string,
  projectPath: string
): string {
  const hash = shortHash(projectPath);
  return `~/.mux/plans/${projectName}-${hash}/${workspaceName}.md`;
}

/**
 * Get the legacy plan file path (stored by workspace ID).
 * Used for migration: when reading, check new path first, then fall back to legacy.
 *
 * @param workspaceId - Stable workspace identifier (e.g., "a1b2c3d4e5")
 */
export function getLegacyPlanFilePath(workspaceId: string): string {
  return `~/.mux/plans/${workspaceId}.md`;
}
