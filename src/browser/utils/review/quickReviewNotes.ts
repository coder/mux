/**
 * Utilities for building quick review notes from hunks in immersive mode.
 * These create whole-hunk ReviewNoteData for "I like this" / "I don't like this" actions.
 */

import type { DiffHunk, ReviewNoteData } from "@/common/types/review";

/**
 * Build a ReviewNoteData for the entire hunk with a prefilled user note.
 * Used by the quick feedback actions in immersive review mode.
 */
export function buildQuickHunkReviewNote(params: {
  hunk: DiffHunk;
  userNote: string;
}): ReviewNoteData {
  const { hunk, userNote } = params;

  const lines = hunk.content.split("\n").filter((line) => line.length > 0);

  // Compute line number ranges, omitting segments for pure additions/deletions
  const oldRange =
    hunk.oldLines > 0 ? `-${hunk.oldStart}-${hunk.oldStart + hunk.oldLines - 1}` : null;
  const newRange =
    hunk.newLines > 0 ? `+${hunk.newStart}-${hunk.newStart + hunk.newLines - 1}` : null;
  const lineRange = [oldRange, newRange].filter(Boolean).join(" ");

  const oldEnd = hunk.oldLines > 0 ? hunk.oldStart + hunk.oldLines - 1 : hunk.oldStart;
  const newEnd = hunk.newLines > 0 ? hunk.newStart + hunk.newLines - 1 : hunk.newStart;

  // Build selectedCode with line numbers (matching DiffRenderer format)
  const oldWidth = Math.max(1, String(oldEnd).length);
  const newWidth = Math.max(1, String(newEnd).length);

  let oldNum = hunk.oldStart;
  let newNum = hunk.newStart;
  const codeLines = lines.map((line) => {
    const indicator = line[0] ?? " ";
    const content = line.slice(1);
    let oldStr = "";
    let newStr = "";

    if (indicator === "+") {
      newStr = String(newNum);
      newNum++;
    } else if (indicator === "-") {
      oldStr = String(oldNum);
      oldNum++;
    } else {
      oldStr = String(oldNum);
      newStr = String(newNum);
      oldNum++;
      newNum++;
    }

    return `${oldStr.padStart(oldWidth)} ${newStr.padStart(newWidth)} ${indicator} ${content}`;
  });

  // Elide middle lines if more than 20
  const CONTEXT_LINES = 10;
  const MAX_FULL_LINES = CONTEXT_LINES * 2;
  let selectedCode: string;
  if (codeLines.length <= MAX_FULL_LINES) {
    selectedCode = codeLines.join("\n");
  } else {
    const omittedCount = codeLines.length - MAX_FULL_LINES;
    selectedCode = [
      ...codeLines.slice(0, CONTEXT_LINES),
      `    (${omittedCount} lines omitted)`,
      ...codeLines.slice(-CONTEXT_LINES),
    ].join("\n");
  }

  return {
    filePath: hunk.filePath,
    lineRange,
    selectedCode,
    selectedDiff: hunk.content,
    oldStart: hunk.oldStart,
    newStart: hunk.newStart,
    userNote,
  };
}
