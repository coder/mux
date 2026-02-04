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
  const lines = output.split("\n");
  const bytes = Buffer.byteLength(output, "utf-8");

  if (lines.length <= BASH_HARD_MAX_LINES && bytes <= BASH_MAX_TOTAL_BYTES) {
    return { output, truncated: false, originalLines: lines.length, originalBytes: bytes };
  }

  // Keep tail (most recent output is usually most relevant for debugging)
  let truncatedLines = lines.slice(-BASH_HARD_MAX_LINES);
  let truncatedOutput = truncatedLines.join("\n");

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
