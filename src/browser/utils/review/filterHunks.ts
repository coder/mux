import type { DiffHunk } from "@/common/types/review";

/**
 * Frontend hunk filters - applied to already-loaded hunks in memory.
 * For git-level filtering (path, diffBase), see ReviewPanel's loadDiff effect.
 */

/**
 * Filter hunks by read state
 * @param hunks - Hunks to filter
 * @param isRead - Function to check if a hunk is read
 * @param showRead - If true, show all hunks; if false, hide read hunks
 */
export function filterByReadState(
  hunks: DiffHunk[],
  isRead: (id: string) => boolean,
  showRead: boolean
): DiffHunk[] {
  if (showRead) return hunks;
  return hunks.filter((hunk) => !isRead(hunk.id));
}

/**
 * Filter hunks by search term
 * Searches in both filename and hunk content
 * @param hunks - Hunks to filter
 * @param searchTerm - Search string (substring or regex)
 * @param useRegex - If true, treat searchTerm as regex pattern
 * @param matchCase - If true, perform case-sensitive search
 */
export function filterBySearch(
  hunks: DiffHunk[],
  searchTerm: string,
  useRegex = false,
  matchCase = false
): DiffHunk[] {
  if (!searchTerm.trim()) return hunks;

  if (useRegex) {
    try {
      const flags = matchCase ? "" : "i"; // case-insensitive unless matchCase is true
      const regex = new RegExp(searchTerm, flags);
      return hunks.filter((hunk) => {
        // Search in filename or hunk content
        return regex.test(hunk.filePath) || regex.test(hunk.content);
      });
    } catch {
      // Invalid regex - return empty array
      return [];
    }
  } else {
    // Substring search
    if (matchCase) {
      // Case-sensitive substring search
      return hunks.filter((hunk) => {
        return hunk.filePath.includes(searchTerm) || hunk.content.includes(searchTerm);
      });
    } else {
      // Case-insensitive substring search
      const searchLower = searchTerm.toLowerCase();
      return hunks.filter((hunk) => {
        return (
          hunk.filePath.toLowerCase().includes(searchLower) ||
          hunk.content.toLowerCase().includes(searchLower)
        );
      });
    }
  }
}

/**
 * Apply all frontend filters in sequence.
 * Order matters: cheaper filters first (read state check < string search).
 *
 * @param hunks - Base hunks array to filter
 * @param filters - Filter configuration
 */
export function applyFrontendFilters(
  hunks: DiffHunk[],
  filters: {
    showReadHunks: boolean;
    isRead: (id: string) => boolean;
    searchTerm: string;
    useRegex?: boolean;
    matchCase?: boolean;
  }
): DiffHunk[] {
  let result = hunks;
  result = filterByReadState(result, filters.isRead, filters.showReadHunks);
  result = filterBySearch(result, filters.searchTerm, filters.useRegex, filters.matchCase);
  return result;
}
