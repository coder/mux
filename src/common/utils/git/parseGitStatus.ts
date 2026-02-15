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

  // Note: dirty + line deltas + branch are computed separately in the caller
  return {
    branch: "",
    ahead,
    behind,
    dirty: false,
    outgoingAdditions: 0,
    outgoingDeletions: 0,
    incomingAdditions: 0,
    incomingDeletions: 0,
  };
}
