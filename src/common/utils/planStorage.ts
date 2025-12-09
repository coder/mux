/**
 * Get the plan file path for a workspace.
 * Returns a path with ~ prefix that works with both local and SSH runtimes.
 * The runtime will expand ~ to the appropriate home directory.
 *
 * Plan files are stored at: ~/.mux/plans/{workspaceId}.md
 */
export function getPlanFilePath(workspaceId: string): string {
  return `~/.mux/plans/${workspaceId}.md`;
}
