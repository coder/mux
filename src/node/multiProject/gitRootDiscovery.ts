import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Discovers git repository roots within a workspace path.
 *
 * For single-project workspaces (workspace itself has .git), returns [workspacePath].
 * For multi-project workspaces (children have .git), returns each child path.
 * Follows symlinks when checking children.
 *
 * Returns empty array if no git roots are found.
 */
export async function discoverGitRoots(workspacePath: string): Promise<string[]> {
  assert(workspacePath.trim().length > 0, "discoverGitRoots requires a non-empty workspacePath");

  const entries = await fs.readdir(workspacePath, { withFileTypes: true });
  const roots: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }

    const childPath = path.join(workspacePath, entry.name);
    const gitPath = path.join(childPath, ".git");

    try {
      await fs.access(gitPath);
      roots.push(childPath);
    } catch {
      // Not a git root — skip.
    }
  }

  // Single-project workspaces keep .git at the workspace root. Only check this
  // fallback when no child repositories were discovered.
  if (roots.length === 0) {
    try {
      await fs.access(path.join(workspacePath, ".git"));
      roots.push(workspacePath);
    } catch {
      // Workspace is not a git repository.
    }
  }

  return roots;
}
