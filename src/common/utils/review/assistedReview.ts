/**
 * Helpers for the agent-driven "Assisted review" feature.
 *
 * The `review_pane_update` tool lets an agent flag specific code regions for
 * user review. Each filter is a string like:
 *
 *   src/foo/bar.ts            // whole file
 *   src/foo/bar.ts:42         // single line
 *   src/foo/bar.ts:42-58      // inclusive line range (new-file numbering)
 *
 * This module parses those strings, normalizes them into {@link AssistedReviewHunk},
 * and matches them against concrete {@link DiffHunk}s loaded in the review pane.
 *
 * Matching is intentionally simple and forgiving: paths must match exactly
 * (workspace-relative); ranges are tested for overlap on the new-side line
 * numbers. Whole-file filters match every hunk for that path.
 */

import type { AssistedReviewHunk, DiffHunk } from "@/common/types/review";

/** Maximum number of assisted hunks an agent may set in a single update. */
export const ASSISTED_REVIEW_MAX_HUNKS = 100;

export interface ParsedAssistedFilter {
  path: string;
  range?: { start: number; end: number };
}

/**
 * Parse a single `path[:range]` filter string. Returns null if the path is
 * empty or the range portion is malformed.
 */
export function parseAssistedFilter(input: string): ParsedAssistedFilter | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Split on the LAST ':' so paths containing colons (e.g. Windows drive letters,
  // though uncommon for workspace-relative paths) survive when the suffix is
  // not a valid range. We probe the suffix as a range first and fall back to
  // treating the whole string as a path.
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) {
    return { path: trimmed };
  }

  const maybePath = trimmed.slice(0, lastColon);
  const maybeRange = trimmed.slice(lastColon + 1);
  const range = parseLineRange(maybeRange);
  if (range && maybePath) {
    return { path: maybePath, range };
  }
  return { path: trimmed };
}

function parseLineRange(raw: string): { start: number; end: number } | null {
  const match = /^(\d+)(?:-(\d+))?$/.exec(raw.trim());
  if (!match) return null;
  const a = Number(match[1]);
  const b = match[2] ? Number(match[2]) : a;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < 1) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/**
 * Test whether a {@link DiffHunk} satisfies an {@link AssistedReviewHunk} filter.
 *
 * Path match is exact (workspace-relative). When the filter has no range, any
 * hunk in the file matches. Otherwise we check overlap against the hunk's
 * new-file span; for purely deleted regions (newLines=0) we fall back to the
 * old-file span so deletions can still be flagged.
 */
export function hunkMatchesAssisted(hunk: DiffHunk, filter: AssistedReviewHunk): boolean {
  if (hunk.filePath !== filter.path && hunk.oldPath !== filter.path) {
    return false;
  }
  if (!filter.range) return true;

  const { start, end } = filter.range;
  const useOld = hunk.newLines === 0 && hunk.oldLines > 0;
  const hStart = useOld ? hunk.oldStart : hunk.newStart;
  const hLines = useOld ? hunk.oldLines : hunk.newLines;
  const hEnd = hStart + Math.max(hLines, 1) - 1;
  return hStart <= end && hEnd >= start;
}

/**
 * For a given hunk, return the first matching assisted entry (and its index)
 * or null. The index lets the UI preserve the agent-declared ordering when
 * pinning matches to the top of the list.
 */
export function findAssistedMatch(
  hunk: DiffHunk,
  assisted: readonly AssistedReviewHunk[]
): { entry: AssistedReviewHunk; index: number } | null {
  for (let i = 0; i < assisted.length; i++) {
    if (hunkMatchesAssisted(hunk, assisted[i])) {
      return { entry: assisted[i], index: i };
    }
  }
  return null;
}

/**
 * Format an assisted hunk for display / round-trip back to the agent.
 */
export function formatAssistedFilter(hunk: AssistedReviewHunk): string {
  if (!hunk.range) return hunk.path;
  const { start, end } = hunk.range;
  return start === end ? `${hunk.path}:${start}` : `${hunk.path}:${start}-${end}`;
}
