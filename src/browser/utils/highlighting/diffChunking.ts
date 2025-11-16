import type { DiffLineType } from "@/browser/components/shared/DiffRenderer";

export interface DiffChunk {
  type: Exclude<DiffLineType, "header">; // 'add' | 'remove' | 'context'
  lines: string[]; // Line content (without +/- prefix)
  startIndex: number; // Original line index in diff
  lineNumbers: number[]; // Line numbers for display
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
      }
      continue;
    }

    // Determine line type and number
    let type: Exclude<DiffLineType, "header">;
    let lineNum: number;

    if (firstChar === "+") {
      type = "add";
      lineNum = newLineNum++;
    } else if (firstChar === "-") {
      type = "remove";
      lineNum = oldLineNum++;
    } else {
      type = "context";
      lineNum = oldLineNum;
      oldLineNum++;
      newLineNum++;
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
        lineNumbers: [],
      };
    }

    // Add line to current chunk (without +/- prefix)
    currentChunk.lines.push(line.slice(1));
    currentChunk.lineNumbers.push(lineNum);
  }

  // Flush final chunk
  if (currentChunk && currentChunk.lines.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
