import type { DiffLineType } from "@/browser/components/shared/DiffRenderer";

export interface DiffChunk {
  type: Exclude<DiffLineType, "header">; // 'add' | 'remove' | 'context'
  lines: string[]; // Line content (without +/- prefix)
  startIndex: number; // Original line index in diff
  oldLineNumbers: Array<number | null>;
  newLineNumbers: Array<number | null>;
}

/**
 * Group consecutive lines of same type into chunks
 * This provides more syntactic context to the highlighter
 */
export function groupDiffLines(lines: string[], oldStart: number, newStart: number): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let currentChunk: DiffChunk | null = null;

  let oldLineNum = oldStart;
  let newLineNum = newStart;
  let hasOldSide = oldStart > 0;
  let hasNewSide = newStart > 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstChar = line[0];

    // Skip headers (@@) - they reset line numbers
    if (line.startsWith("@@")) {
      // Flush current chunk
      if (currentChunk && currentChunk.lines.length > 0) {
        chunks.push(currentChunk);
        currentChunk = null;
      }

      // Parse header for line numbers
      const regex = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
      const match = regex.exec(line);
      if (match) {
        oldLineNum = parseInt(match[1], 10);
        newLineNum = parseInt(match[2], 10);
        hasOldSide = oldLineNum > 0;
        hasNewSide = newLineNum > 0;
      }
      continue;
    }

    // Determine line type and line numbers.
    let type: Exclude<DiffLineType, "header">;
    let oldLineNumber: number | null;
    let newLineNumber: number | null;
    let lineContent: string;

    // Meta lines (e.g. "\\ No newline at end of file") should not affect line numbering.
    const isMetaLine = firstChar !== "+" && firstChar !== "-" && firstChar !== " ";

    if (isMetaLine) {
      type = "context";
      oldLineNumber = null;
      newLineNumber = null;
      lineContent = line;
    } else if (firstChar === "+") {
      type = "add";
      oldLineNumber = null;
      newLineNumber = hasNewSide ? newLineNum++ : null;
      lineContent = line.slice(1);
    } else if (firstChar === "-") {
      type = "remove";
      oldLineNumber = hasOldSide ? oldLineNum++ : null;
      newLineNumber = null;
      lineContent = line.slice(1);
    } else {
      type = "context";
      oldLineNumber = hasOldSide ? oldLineNum++ : null;
      newLineNumber = hasNewSide ? newLineNum++ : null;
      lineContent = line.slice(1);
    }

    // Start new chunk if type changed or no current chunk
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
    if (!currentChunk || currentChunk.type !== type) {
      // Flush previous chunk if it exists
      if (currentChunk?.lines.length) {
        chunks.push(currentChunk);
      }
      // Start new chunk
      currentChunk = {
        type,
        lines: [],
        startIndex: i,
        oldLineNumbers: [],
        newLineNumbers: [],
      };
    }

    // Add line to current chunk (without +/- prefix, except for meta lines)
    currentChunk.lines.push(lineContent);
    currentChunk.oldLineNumbers.push(oldLineNumber);
    currentChunk.newLineNumbers.push(newLineNumber);
  }

  // Flush final chunk
  if (currentChunk && currentChunk.lines.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
