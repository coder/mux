/**
 * Navigation utilities for the review panel.
 * These pure functions compute the next/previous hunk to navigate to.
 */

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
