/**
 * Hard truncation for bash output to prevent unbounded context growth.
 *
 * This is a safety net that applies the same limits as foreground bash
 * (BASH_HARD_MAX_LINES / BASH_MAX_TOTAL_BYTES) to all bash-family tool output.
 *
 * Used by maybeFilterBashOutputWithSystem1 to ensure output is bounded even
 * when System1 compaction is skipped or fails.
 */

import { BASH_HARD_MAX_LINES, BASH_MAX_TOTAL_BYTES } from "@/common/constants/toolLimits";

export interface TruncateBashOutputResult {
  output: string;
  truncated: boolean;
  originalLines: number;
  originalBytes: number;
}

export function truncateBashOutput(output: string): TruncateBashOutputResult {
  const bytes = Buffer.byteLength(output, "utf-8");

  // Split into lines, but don't count a trailing empty string as a line.
  // "line1\nline2\n".split("\n") gives ["line1", "line2", ""], but that's 2 lines, not 3.
  const rawLines = output.split("\n");
  const hasTrailingNewline = output.endsWith("\n") && rawLines.length > 0;
  const lines = hasTrailingNewline ? rawLines.slice(0, -1) : rawLines;

  if (lines.length <= BASH_HARD_MAX_LINES && bytes <= BASH_MAX_TOTAL_BYTES) {
    return { output, truncated: false, originalLines: lines.length, originalBytes: bytes };
  }

  // Keep tail (most recent output is usually most relevant for debugging)
  let truncatedLines = lines.slice(-BASH_HARD_MAX_LINES);
  // Restore trailing newline if original had one
  let truncatedOutput = truncatedLines.join("\n") + (hasTrailingNewline ? "\n" : "");

  // Also enforce byte limit (slice from end to keep recent output)
  if (Buffer.byteLength(truncatedOutput, "utf-8") > BASH_MAX_TOTAL_BYTES) {
    // Binary search would be more efficient but this is simple and correct
    while (Buffer.byteLength(truncatedOutput, "utf-8") > BASH_MAX_TOTAL_BYTES) {
      truncatedLines = truncatedLines.slice(1);
      truncatedOutput = truncatedLines.join("\n");
    }
  }

  return {
    output: truncatedOutput,
    truncated: true,
    originalLines: lines.length,
    originalBytes: bytes,
  };
}
