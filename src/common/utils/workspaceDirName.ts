/**
 * Encodes a workspace name for safe use as a filesystem directory name.
 *
 * Uses encodeURIComponent which:
 * - Is deterministic and collision-free
 * - Leaves simple names unchanged (e.g., "main", "foo-bar")
 * - Converts slashes: "feature/foo" → "feature%2Ffoo"
 *
 * This ensures workspace names like "feature/foo" don't create nested directories.
 */
export function encodeWorkspaceNameForDir(workspaceName: string): string {
  return encodeURIComponent(workspaceName);
}

/**
 * Decodes a filesystem directory name back to the original workspace name.
 *
 * Useful for debugging and diagnostics. Not needed for normal runtime operations
 * since we always work with the original workspace name from metadata.
 */
export function decodeWorkspaceNameFromDir(dirName: string): string {
  return decodeURIComponent(dirName);
}
