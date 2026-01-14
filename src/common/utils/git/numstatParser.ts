/**
 * Parse git diff --numstat output
 * Format: <additions>\t<deletions>\t<filepath>
 */
import type { FileChangeType } from "@/common/types/review";

export interface FileStats {
  filePath: string;
  additions: number;
  deletions: number;
  changeType?: FileChangeType;
  oldPath?: string;
}

/**
 * Parse git diff --numstat output into structured file stats
 */
export function parseNumstat(numstatOutput: string): FileStats[] {
  const lines = numstatOutput.trim().split("\n").filter(Boolean);
  const stats: FileStats[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length !== 3) continue;

    const [addStr, delStr, filePath] = parts;

    // Handle binary files (marked with "-" for additions/deletions)
    const additions = addStr === "-" ? 0 : parseInt(addStr, 10);
    const deletions = delStr === "-" ? 0 : parseInt(delStr, 10);

    if (!isNaN(additions) && !isNaN(deletions)) {
      stats.push({
        filePath,
        additions,
        deletions,
      });
    }
  }

  return stats;
}

/**
 * Extract the new file path from rename syntax
 * Examples:
 *   "src/foo.ts" -> "src/foo.ts"
 *   "src/{old.ts => new.ts}" -> "src/new.ts"
 *   "{old.ts => new.ts}" -> "new.ts"
 */
export function extractNewPath(filePath: string): string {
  // Match rename syntax: {old => new}
  const renameMatch = /^(.*)?\{[^}]+ => ([^}]+)\}(.*)$/.exec(filePath);
  if (renameMatch) {
    const [, prefix = "", newName, suffix = ""] = renameMatch;
    return `${prefix}${newName}${suffix}`;
  }

  // Match rename syntax without braces: "old => new"
  const arrowSeparator = " => ";
  if (filePath.includes(arrowSeparator)) {
    return filePath.split(arrowSeparator).pop() ?? filePath;
  }

  return filePath;
}

/**
 * Build a tree structure from flat file paths
 */
export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: FileTreeNode[];
  /** Whether this file/directory is gitignored */
  ignored?: boolean;
  stats?: FileStats;
  /** Total stats including all children (for directories) */
  totalStats?: FileStats;
}

export function buildFileTree(fileStats: FileStats[]): FileTreeNode {
  const root: FileTreeNode = {
    name: "",
    path: "",
    isDirectory: true,
    children: [],
  };

  for (const stat of fileStats) {
    const parts = stat.filePath.split("/");
    let currentNode = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLastPart = i === parts.length - 1;
      const pathSoFar = parts.slice(0, i + 1).join("/");

      let childNode = currentNode.children.find((c) => c.name === part);

      if (!childNode) {
        childNode = {
          name: part,
          path: pathSoFar,
          isDirectory: !isLastPart,
          children: [],
          stats: isLastPart ? stat : undefined,
        };
        currentNode.children.push(childNode);
      }

      currentNode = childNode;
    }
  }

  // Calculate total stats for all directory nodes
  function populateTotalStats(node: FileTreeNode): void {
    if (node.isDirectory) {
      let totalAdditions = 0;
      let totalDeletions = 0;

      for (const child of node.children) {
        populateTotalStats(child); // Recursive

        const childStats = child.isDirectory ? child.totalStats : child.stats;

        if (childStats) {
          totalAdditions += childStats.additions;
          totalDeletions += childStats.deletions;
        }
      }

      node.totalStats = {
        additions: totalAdditions,
        deletions: totalDeletions,
        filePath: node.path, // Add filePath to satisfy FileStats interface
      };
    }
  }

  populateTotalStats(root);

  return root;
}

/**
 * Extract the common path prefix from all file paths
 * Returns null if no common prefix or only single path component
 *
 * This is used for display purposes only - the actual paths in the tree
 * remain unchanged so git commands work correctly.
 */
export function extractCommonPrefix(fileStats: FileStats[]): string | null {
  if (fileStats.length === 0) return null;

  // Get all paths
  const paths = fileStats.map((stat) => stat.filePath);

  // Split first path into components
  const firstParts = paths[0].split("/");
  if (firstParts.length === 1) return null; // No directory structure

  // Find common prefix length
  let commonLength = 0;
  for (let i = 0; i < firstParts.length - 1; i++) {
    // -1 to exclude filename
    const part = firstParts[i];
    if (paths.every((path) => path.split("/")[i] === part)) {
      commonLength = i + 1;
    } else {
      break;
    }
  }

  // Return null if no common prefix
  if (commonLength === 0) return null;

  return firstParts.slice(0, commonLength).join("/");
}
