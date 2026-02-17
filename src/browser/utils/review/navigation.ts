/**
 * Navigation utilities for the review panel.
 * These pure functions compute the next/previous hunk to navigate to.
 */

import { extractNewPath, type FileTreeNode } from "@/common/utils/git/numstatParser";
import type { DiffHunk } from "@/common/types/review";

/**
 * Find the next hunk ID to navigate to when the current hunk is being removed
 * (e.g., marked as read when "hide read" is enabled).
 *
 * Navigation priority:
 * 1. Next hunk in the list (if available)
 * 2. Previous hunk in the list (if no next)
 * 3. null (if list becomes empty)
 *
 * @param hunks The current filtered/sorted list of hunks
 * @param currentHunkId The ID of the hunk being removed
 * @returns The ID of the next hunk to select, or null if none
 */
export function findNextHunkId(hunks: DiffHunk[], currentHunkId: string): string | null {
  const currentIndex = hunks.findIndex((h) => h.id === currentHunkId);
  if (currentIndex === -1) return null;

  // Prefer next, then previous, then null
  if (currentIndex < hunks.length - 1) {
    return hunks[currentIndex + 1].id;
  } else if (currentIndex > 0) {
    return hunks[currentIndex - 1].id;
  }
  return null;
}

/**
 * Find the next hunk ID to navigate to when all hunks in a file are being removed.
 * Searches forward from current position for a hunk in a different file, then backward.
 *
 * @param hunks The current filtered/sorted list of hunks
 * @param currentHunkId The ID of the current hunk
 * @param filePath The file path to exclude (all hunks from this file will be removed)
 * @returns The ID of the next hunk to select, or null if none
 */
export function findNextHunkIdAfterFileRemoval(
  hunks: DiffHunk[],
  currentHunkId: string,
  filePath: string
): string | null {
  const currentIndex = hunks.findIndex((h) => h.id === currentHunkId);
  if (currentIndex === -1) return null;

  // Search forward from current position for a hunk in a different file
  const nextInDifferentFile = hunks.slice(currentIndex + 1).find((h) => h.filePath !== filePath);
  if (nextInDifferentFile) {
    return nextInDifferentFile.id;
  }

  // No hunk after, try before
  const prevInDifferentFile = hunks
    .slice(0, currentIndex)
    .reverse()
    .find((h) => h.filePath !== filePath);
  if (prevInDifferentFile) {
    return prevInDifferentFile.id;
  }

  return null;
}

/**
 * Flatten a FileTreeNode into a sorted list of leaf file paths.
 * Traverses the tree depth-first, collecting only leaf nodes (files, not dirs).
 */
export function flattenFileTreeLeaves(root: FileTreeNode | null): string[] {
  if (!root) return [];
  const result: string[] = [];

  function walk(node: FileTreeNode, prefix: string) {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        walk(child, path);
      }
    } else {
      // Leaf node = file; normalize rename syntax (e.g., "src/{old.ts => new.ts}" → "src/new.ts")
      result.push(extractNewPath(path));
    }
  }

  // Root is virtual (""), walk children directly
  for (const child of root.children ?? []) {
    walk(child, "");
  }
  return result;
}

/**
 * Get the next or previous file path in a list, wrapping around.
 */
export function getAdjacentFilePath(
  files: string[],
  current: string,
  direction: 1 | -1
): string | null {
  if (files.length === 0) return null;
  const idx = files.indexOf(current);
  if (idx === -1) return files[0];
  const next = (idx + direction + files.length) % files.length;
  return files[next];
}

/**
 * Filter hunks to only those matching a specific file path.
 */
export function getFileHunks(hunks: DiffHunk[], filePath: string): DiffHunk[] {
  return hunks.filter((h) => h.filePath === filePath);
}
