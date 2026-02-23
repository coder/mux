/**
 * Utilities for building quick review notes from hunks in immersive mode.
 *
 * - buildQuickHunkReviewNote creates note data for an entire hunk.
 * - buildQuickLineReviewNote creates note data for a selected line range in a hunk.
 */

import type { DiffHunk, ReviewNoteData } from "@/common/types/review";

const CONTEXT_LINES = 10;
const MAX_FULL_LINES = CONTEXT_LINES * 2;

interface QuickReviewLineData {
  raw: string;
  oldLineNum: number | null;
  newLineNum: number | null;
}

function splitDiffLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function formatRange(nums: number[]): string | null {
  if (nums.length === 0) {
    return null;
  }

  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return min === max ? `${min}` : `${min}-${max}`;
}

function buildLineDataForHunk(hunk: DiffHunk): QuickReviewLineData[] {
  const lines = splitDiffLines(hunk.content);
  const lineData: QuickReviewLineData[] = [];

  let oldNum = hunk.oldStart;
  let newNum = hunk.newStart;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const headerMatch = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
      if (headerMatch) {
        oldNum = Number.parseInt(headerMatch[1], 10);
        newNum = Number.parseInt(headerMatch[2], 10);
      }
      continue;
    }

    const indicator = line[0] ?? " ";
    if (indicator === "+") {
      lineData.push({ raw: line, oldLineNum: null, newLineNum: newNum });
      newNum += 1;
      continue;
    }

    if (indicator === "-") {
      lineData.push({ raw: line, oldLineNum: oldNum, newLineNum: null });
      oldNum += 1;
      continue;
    }

    lineData.push({ raw: line, oldLineNum: oldNum, newLineNum: newNum });
    oldNum += 1;
    newNum += 1;
  }

  return lineData;
}

function buildRangeForSelectedLines(selectedLineData: QuickReviewLineData[]): string {
  const oldLineNumbers = selectedLineData
    .map((lineInfo) => lineInfo.oldLineNum)
    .filter((lineNum): lineNum is number => lineNum !== null);
  const newLineNumbers = selectedLineData
    .map((lineInfo) => lineInfo.newLineNum)
    .filter((lineNum): lineNum is number => lineNum !== null);

  const oldRange = formatRange(oldLineNumbers);
  const newRange = formatRange(newLineNumbers);

  return [oldRange ? `-${oldRange}` : null, newRange ? `+${newRange}` : null]
    .filter((part): part is string => part !== null)
    .join(" ");
}

function formatSelectedCode(selectedLineData: QuickReviewLineData[]): string {
  const oldLineNumbers = selectedLineData
    .map((lineInfo) => lineInfo.oldLineNum)
    .filter((lineNum): lineNum is number => lineNum !== null);
  const newLineNumbers = selectedLineData
    .map((lineInfo) => lineInfo.newLineNum)
    .filter((lineNum): lineNum is number => lineNum !== null);

  const oldWidth = Math.max(1, ...oldLineNumbers.map((lineNum) => String(lineNum).length));
  const newWidth = Math.max(1, ...newLineNumbers.map((lineNum) => String(lineNum).length));

  const allLines = selectedLineData.map((lineInfo) => {
    const indicator = lineInfo.raw[0] ?? " ";
    const content = lineInfo.raw.slice(1);
    const oldStr = lineInfo.oldLineNum === null ? "" : String(lineInfo.oldLineNum);
    const newStr = lineInfo.newLineNum === null ? "" : String(lineInfo.newLineNum);

    return `${oldStr.padStart(oldWidth)} ${newStr.padStart(newWidth)} ${indicator} ${content}`;
  });

  if (allLines.length <= MAX_FULL_LINES) {
    return allLines.join("\n");
  }

  const omittedCount = allLines.length - MAX_FULL_LINES;
  return [
    ...allLines.slice(0, CONTEXT_LINES),
    `    (${omittedCount} lines omitted)`,
    ...allLines.slice(-CONTEXT_LINES),
  ].join("\n");
}

/**
 * Build a ReviewNoteData from a selected line range in a hunk.
 * Mirrors ReviewNoteInput formatting in DiffRenderer for consistent payloads.
 */
export function buildQuickLineReviewNote(params: {
  hunk: DiffHunk;
  startIndex: number;
  endIndex: number;
  userNote: string;
}): ReviewNoteData {
  const { hunk, startIndex, endIndex, userNote } = params;
  const lineData = buildLineDataForHunk(hunk);

  if (lineData.length === 0) {
    return buildQuickHunkReviewNote({ hunk, userNote });
  }

  const requestedStart = Math.min(startIndex, endIndex);
  const requestedEnd = Math.max(startIndex, endIndex);
  const clampedStart = Math.max(0, Math.min(requestedStart, lineData.length - 1));
  const clampedEnd = Math.max(clampedStart, Math.min(requestedEnd, lineData.length - 1));
  const selectedLineData = lineData.slice(clampedStart, clampedEnd + 1);

  const oldLineNumbers = selectedLineData
    .map((lineInfo) => lineInfo.oldLineNum)
    .filter((lineNum): lineNum is number => lineNum !== null);
  const newLineNumbers = selectedLineData
    .map((lineInfo) => lineInfo.newLineNum)
    .filter((lineNum): lineNum is number => lineNum !== null);

  return {
    filePath: hunk.filePath,
    lineRange: buildRangeForSelectedLines(selectedLineData),
    selectedCode: formatSelectedCode(selectedLineData),
    selectedDiff: selectedLineData.map((lineInfo) => lineInfo.raw).join("\n"),
    oldStart: oldLineNumbers.length > 0 ? Math.min(...oldLineNumbers) : 1,
    newStart: newLineNumbers.length > 0 ? Math.min(...newLineNumbers) : 1,
    userNote,
  };
}

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
