/**
 * Git diff parser - parses unified diff output into structured hunks
 */

import type { DiffHunk, FileDiff } from "../../types/review";

/**
 * Generate a stable content-based ID for a hunk
 * Uses file path + line range + diff content to ensure uniqueness
 */
function generateHunkId(
  filePath: string,
  oldStart: number,
  newStart: number,
  content: string
): string {
  // Hash file path + line range + diff content for uniqueness and rebase stability
  const str = `${filePath}:${oldStart}-${newStart}:${content}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `hunk-${Math.abs(hash).toString(16)}`;
}

/**
 * Parse a hunk header line (e.g., "@@ -1,5 +1,6 @@ optional context")
 * Returns null if the line is not a valid hunk header
 */
function parseHunkHeader(line: string): {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
} | null {
  const regex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const match = regex.exec(line);
  if (!match) return null;

  return {
    oldStart: parseInt(match[1], 10),
    oldLines: match[2] ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newLines: match[4] ? parseInt(match[4], 10) : 1,
  };
}

/**
 * Parse unified diff output into structured file diffs with hunks
 * Supports standard git diff format with file headers and hunk markers
 */
export function parseDiff(diffOutput: string): FileDiff[] {
  // Defensive: handle undefined/null/empty input
  if (!diffOutput || typeof diffOutput !== "string") {
    return [];
  }

  const lines = diffOutput.split("\n");
  const files: FileDiff[] = [];
  let currentFile: FileDiff | null = null;
  let currentHunk: Partial<DiffHunk> | null = null;
  let hunkLines: string[] = [];

  const finishHunk = () => {
    if (currentHunk && currentFile && hunkLines.length > 0) {
      const content = hunkLines.join("\n");
      const hunkId = generateHunkId(
        currentFile.filePath,
        currentHunk.oldStart!,
        currentHunk.newStart!,
        content
      );
      currentFile.hunks.push({
        ...currentHunk,
        id: hunkId,
        filePath: currentFile.filePath,
        content,
        changeType: currentFile.changeType,
        oldPath: currentFile.oldPath,
      } as DiffHunk);
      hunkLines = [];
      currentHunk = null;
    }
  };

  const finishFile = () => {
    finishHunk();
    if (currentFile) {
      files.push(currentFile);
      currentFile = null;
    }
  };

  for (const line of lines) {
    // File header: diff --git a/... b/...
    if (line.startsWith("diff --git ")) {
      finishFile();
      // Extract file paths from "diff --git a/path b/path"
      const regex = /^diff --git a\/(.+) b\/(.+)$/;
      const match = regex.exec(line);
      if (match) {
        const oldPath = match[1];
        const newPath = match[2];
        currentFile = {
          filePath: newPath,
          oldPath: oldPath !== newPath ? oldPath : undefined,
          changeType: "modified",
          isBinary: false,
          hunks: [],
        };
      }
      continue;
    }

    if (!currentFile) continue;

    // Binary file marker
    if (line.startsWith("Binary files ")) {
      currentFile.isBinary = true;
      continue;
    }

    // New file mode
    if (line.startsWith("new file mode ")) {
      currentFile.changeType = "added";
      continue;
    }

    // Deleted file mode
    if (line.startsWith("deleted file mode ")) {
      currentFile.changeType = "deleted";
      continue;
    }

    // Rename marker
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      currentFile.changeType = "renamed";
      continue;
    }

    // Hunk header
    if (line.startsWith("@@")) {
      finishHunk();
      const parsed = parseHunkHeader(line);
      if (parsed) {
        currentHunk = {
          ...parsed,
          header: line,
        };
      }
      continue;
    }

    // Hunk content (lines starting with +, -, or space)
    if (currentHunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      hunkLines.push(line);
      continue;
    }

    // Context lines in hunk (no prefix, but within a hunk)
    if (currentHunk && line.length === 0) {
      hunkLines.push(" "); // Treat empty line as context
      continue;
    }
  }

  // Finish last file
  finishFile();

  return files;
}

/**
 * Extract all hunks from file diffs
 * Flattens the file -> hunks structure into a single array
 */
export function extractAllHunks(fileDiffs: FileDiff[]): DiffHunk[] {
  return fileDiffs.flatMap((file) => file.hunks);
}
