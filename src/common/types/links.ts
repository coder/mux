/**
 * Types for GitHub PR links and status (branch-based detection).
 */

/**
 * Base link metadata.
 */
export interface BaseLinkMetadata {
  /** Timestamp when the link was detected */
  detectedAt: number;
  /** Number of times this link appeared */
  occurrenceCount: number;
}

/**
 * A GitHub PR link with parsed metadata.
 */
export interface GitHubPRLink extends BaseLinkMetadata {
  type: "github-pr";
  url: string;
  owner: string;
  repo: string;
  number: number;
}

/**
 * PR status information fetched from GitHub via gh CLI.
 */
export interface GitHubPRStatus {
  /** PR state: OPEN, CLOSED, MERGED */
  state: "OPEN" | "CLOSED" | "MERGED";
  /** Whether the PR is mergeable */
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** Merge state status (GitHub merge box state). */
  mergeStateStatus:
    | "CLEAN"
    | "BLOCKED"
    | "BEHIND"
    | "DIRTY"
    | "UNSTABLE"
    | "HAS_HOOKS"
    | "DRAFT"
    | "UNKNOWN";
  /** PR title */
  title: string;
  /** Whether the PR is a draft */
  isDraft: boolean;
  /** Head branch name */
  headRefName: string;
  /** Base branch name */
  baseRefName: string;

  /**
   * Whether any checks are still pending/running.
   * Optional: not all gh versions/API payloads include check rollup data.
   */
  hasPendingChecks?: boolean;

  /**
   * Whether any checks have failed.
   * Optional: not all gh versions/API payloads include check rollup data.
   */
  hasFailedChecks?: boolean;

  /** Last fetched timestamp */
  fetchedAt: number;
}

/**
 * Extended PR link with status information.
 */
export interface GitHubPRLinkWithStatus extends GitHubPRLink {
  status?: GitHubPRStatus;
  /** Whether status is currently being fetched */
  loading?: boolean;
  /** Error message if status fetch failed */
  error?: string;
}
