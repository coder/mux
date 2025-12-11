import type { GitStatus } from "@/common/types/workspace";

/**
 * Parse the output of `git rev-list --left-right --count HEAD...origin/branch`
 *
 * Expected format: "N\tM" where N is ahead count and M is behind count
 *
 * @param output - The raw output from git rev-list command
 * @returns GitStatus object with ahead/behind counts, or null if parsing fails
 */
export function parseGitRevList(output: string): GitStatus | null {
  const trimmed = output.trim();

  if (!trimmed) {
    return null;
  }

  // Split by tab - expected format is "ahead\tbehind"
  const parts = trimmed.split(/\s+/);

  if (parts.length !== 2) {
    return null;
  }

  const ahead = parseInt(parts[0], 10);
  const behind = parseInt(parts[1], 10);

  if (isNaN(ahead) || isNaN(behind)) {
    return null;
  }

  // Note: dirty + line deltas are computed separately in the caller
  return {
    ahead,
    behind,
    dirty: false,
    outgoingAdditions: 0,
    outgoingDeletions: 0,
    incomingAdditions: 0,
    incomingDeletions: 0,
  };
}

/**
 * Parse the output of `git show-branch --sha1-name HEAD origin/branch` to calculate ahead/behind counts.
 *
 * This counts commits shown in the show-branch divergence section, which provides a more
 * meaningful representation of branch divergence than git rev-list.
 *
 * Expected format:
 *   ! [HEAD] commit message
 *    ! [origin/branch] commit message
 *   --
 *   -  [hash] commit in HEAD but not origin
 *   ++ [hash] commit in both
 *    + [hash] commit in origin but not HEAD
 *
 * Indicators:
 * - Column 0 (HEAD): non-space means commit is in HEAD, space means not in HEAD
 * - Column 1 (origin/branch): non-space means commit is in origin/branch, space means not in origin
 *
 * @param output - The raw output from git show-branch command
 * @returns GitStatus object with ahead/behind counts, or null if parsing fails
 */
export function parseGitShowBranchForStatus(output: string): GitStatus | null {
  const trimmed = output.trim();

  if (!trimmed) {
    return null;
  }

  const lines = trimmed.split("\n");
  let inCommitSection = false;
  let ahead = 0;
  let behind = 0;

  for (const line of lines) {
    // Skip until we find the separator "--" or "---"
    if (line.trim() === "--" || line.trim() === "---") {
      inCommitSection = true;
      continue;
    }

    if (!inCommitSection) {
      continue; // Skip header lines
    }

    // Match commit lines: <indicators> [<hash>] <subject>
    // We need at least 2 characters for the indicators (column 0 and column 1)
    if (line.length < 2) {
      continue;
    }

    // Check if this line has a hash (commit line)
    if (!/\[[a-f0-9]+\]/.test(line)) {
      continue;
    }

    // Extract indicators (first 2 characters represent HEAD and origin/branch)
    const headIndicator = line[0];
    const originIndicator = line[1];

    // Check if in HEAD but not in origin (ahead)
    if (headIndicator !== " " && originIndicator === " ") {
      ahead++;
    }
    // Check if in origin but not in HEAD (behind)
    else if (headIndicator === " " && originIndicator !== " ") {
      behind++;
    }
  }

  // Note: dirty + line deltas are computed separately in the caller
  return {
    ahead,
    behind,
    dirty: false,
    outgoingAdditions: 0,
    outgoingDeletions: 0,
    incomingAdditions: 0,
    incomingDeletions: 0,
  };
}
