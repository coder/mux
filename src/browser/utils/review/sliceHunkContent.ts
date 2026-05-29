import type { DiffHunk } from "@/common/types/review";

/**
 * Slice a {@link DiffHunk}'s body into three contiguous regions — before,
 * inside, and after the agent-flagged new-side line range. The slicer
 * mirrors the line-numbering algorithm used by `groupDiffLines` so the
 * `oldStart` / `newStart` we return for each region can be fed back into
 * `SelectableDiffRenderer` without further accounting.
 *
 * Inclusion rules:
 * - `+` lines belong to the region containing their new-line number.
 * - ` ` (context) lines belong to the region containing their new-line number.
 * - `-` lines have no new-line number, so we attach each `-` to the region
 *   of the next non-`-` line going forward. Trailing `-` lines (no following
 *   line in the hunk) attach to the region of the last preceding line.
 *
 * The slicer returns `null` whenever trimming is a no-op or doesn't apply
 * (range covers the whole hunk, range out of bounds, pure rename, etc.) so
 * callers can fall back to rendering the full hunk unchanged.
 */

export interface HunkSlice {
  /** Raw diff lines (with +/-/space prefix, NL-joined) — may be empty. */
  beforeContent: string;
  insideContent: string;
  afterContent: string;
  /** Counter starts for each slice; consumed by SelectableDiffRenderer. */
  beforeOldStart: number;
  beforeNewStart: number;
  insideOldStart: number;
  insideNewStart: number;
  afterOldStart: number;
  afterNewStart: number;
  /** Number of *lines in the diff body* that belong to before/after. */
  beforeLineCount: number;
  afterLineCount: number;
}

interface AnnotatedLine {
  raw: string;
  /** 'add' | 'remove' | 'context' | 'other' (e.g. defensive @@-skip case) */
  kind: "add" | "remove" | "context" | "other";
  /** New-side line number — null for `-` lines. */
  newLineNumber: number | null;
  /** Old-side line number — null for `+` lines. */
  oldLineNumber: number | null;
}

function annotateHunkLines(hunk: DiffHunk): {
  lines: AnnotatedLine[];
  finalOld: number;
  finalNew: number;
} {
  const rawLines = hunk.content.split("\n").filter((l) => l.length > 0);

  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const lines: AnnotatedLine[] = [];

  for (const raw of rawLines) {
    // Defensive: DiffHunk.content shouldn't include @@ headers but the parent
    // group-diff helper guards against them too, so mirror that behavior.
    if (raw.startsWith("@@")) {
      const regex = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
      const match = regex.exec(raw);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      lines.push({ raw, kind: "other", oldLineNumber: null, newLineNumber: null });
      continue;
    }

    const firstChar = raw[0];
    if (firstChar === "+") {
      lines.push({ raw, kind: "add", oldLineNumber: null, newLineNumber: newLine });
      newLine++;
    } else if (firstChar === "-") {
      lines.push({ raw, kind: "remove", oldLineNumber: oldLine, newLineNumber: null });
      oldLine++;
    } else {
      lines.push({ raw, kind: "context", oldLineNumber: oldLine, newLineNumber: newLine });
      oldLine++;
      newLine++;
    }
  }

  return { lines, finalOld: oldLine, finalNew: newLine };
}

/**
 * Pick the "region" (before=0, inside=1, after=2) for each annotated line
 * given the inclusive new-side range. Removal lines borrow the region of the
 * next non-removal line; trailing removals borrow the preceding line.
 */
function assignRegions(lines: AnnotatedLine[], rangeStart: number, rangeEnd: number): number[] {
  const regions: number[] = new Array<number>(lines.length).fill(0);

  // First pass: assign regions for everything except remove lines.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.kind === "remove" || l.kind === "other") {
      regions[i] = -1;
      continue;
    }
    if (l.newLineNumber == null) {
      regions[i] = 0;
      continue;
    }
    if (l.newLineNumber < rangeStart) regions[i] = 0;
    else if (l.newLineNumber > rangeEnd) regions[i] = 2;
    else regions[i] = 1;
  }

  // Second pass: attach unassigned (-) lines to the next assigned region.
  let lastAssigned = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (regions[i] !== -1) {
      lastAssigned = regions[i];
      continue;
    }
    regions[i] = lastAssigned;
  }
  // Trailing unassigned (no later region) → attach to the previous region.
  if (regions.some((r) => r === -1)) {
    let prev = 0;
    for (let i = 0; i < lines.length; i++) {
      if (regions[i] !== -1) {
        prev = regions[i];
        continue;
      }
      regions[i] = prev;
    }
  }

  return regions;
}

export function sliceHunkByNewLineRange(
  hunk: DiffHunk,
  range: { start: number; end: number }
): HunkSlice | null {
  // Pure rename: the body has no diff lines, nothing to trim.
  if (hunk.changeType === "renamed" && hunk.newLines === 0 && hunk.oldLines === 0) {
    return null;
  }
  // Pure deletion: no new-side numbers to filter by; surface the entire hunk.
  if (hunk.newLines === 0) return null;

  const hunkNewStart = hunk.newStart;
  const hunkNewEnd = hunk.newStart + hunk.newLines - 1;
  // Range completely outside the hunk — caller falls back to the full hunk
  // (defensive; ReviewPanel only ever passes a range from a matched filter).
  if (range.end < hunkNewStart || range.start > hunkNewEnd) return null;

  // Clamp to the hunk's bounds.
  const clampedStart = Math.max(range.start, hunkNewStart);
  const clampedEnd = Math.min(range.end, hunkNewEnd);

  // Range covers the whole hunk → no trimming needed.
  if (clampedStart <= hunkNewStart && clampedEnd >= hunkNewEnd) return null;

  const { lines } = annotateHunkLines(hunk);
  const regions = assignRegions(lines, clampedStart, clampedEnd);

  const beforeLines: AnnotatedLine[] = [];
  const insideLines: AnnotatedLine[] = [];
  const afterLines: AnnotatedLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (regions[i] === 0) beforeLines.push(lines[i]);
    else if (regions[i] === 1) insideLines.push(lines[i]);
    else afterLines.push(lines[i]);
  }

  // Sanity check: if the inside slice ended up empty, bail rather than render
  // a misleading "everything is above/below" view.
  if (insideLines.length === 0) return null;

  // Compute per-slice line-number starts. For each slice, the start is the
  // first non-null old/new number we see; if a slice has no such line, fall
  // back to the position of the slice in the hunk so downstream rendering
  // is still self-consistent.
  const firstOldOf = (arr: AnnotatedLine[]): number | null => {
    for (const l of arr) if (l.oldLineNumber != null) return l.oldLineNumber;
    return null;
  };
  const firstNewOf = (arr: AnnotatedLine[]): number | null => {
    for (const l of arr) if (l.newLineNumber != null) return l.newLineNumber;
    return null;
  };

  const beforeOldStart = firstOldOf(beforeLines) ?? hunk.oldStart;
  const beforeNewStart = firstNewOf(beforeLines) ?? hunk.newStart;
  const insideOldStart = firstOldOf(insideLines) ?? beforeOldStart;
  const insideNewStart = firstNewOf(insideLines) ?? clampedStart;
  const afterOldStart = firstOldOf(afterLines) ?? insideOldStart;
  const afterNewStart = firstNewOf(afterLines) ?? clampedEnd + 1;

  const joinRaw = (arr: AnnotatedLine[]) => arr.map((l) => l.raw).join("\n");

  return {
    beforeContent: joinRaw(beforeLines),
    insideContent: joinRaw(insideLines),
    afterContent: joinRaw(afterLines),
    beforeOldStart,
    beforeNewStart,
    insideOldStart,
    insideNewStart,
    afterOldStart,
    afterNewStart,
    beforeLineCount: beforeLines.length,
    afterLineCount: afterLines.length,
  };
}
