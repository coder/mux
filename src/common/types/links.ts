/**
 * Types for detected links in chat messages.
 * Links are extracted incrementally during message streaming.
 */

/**
 * Base link metadata common to all link types.
 */
export interface BaseLinkMetadata {
  /** Timestamp when the link was last detected (used for sorting + "last seen" UI) */
  detectedAt: number;
  /** Number of times this link appeared in messages */
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
 * A generic link (non-PR).
 */
export interface GenericLink extends BaseLinkMetadata {
  type: "generic";
  url: string;
  /** Optional display text extracted from markdown [text](url) */
  title?: string;
}

/**
 * Union of all detected link types.
 */
export type DetectedLink = GitHubPRLink | GenericLink;

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

/**
 * Extract all URLs from a text string.
 * Uses a simple regex that matches http/https URLs.
 * Handles markdown artifacts, terminal output, and trailing punctuation.
 */
export function extractUrls(text: string): string[] {
  // Match URLs starting with http:// or https://
  // Stop at: whitespace, quotes, brackets, backticks, backslashes, or end of string
  const urlRegex = /https?:\/\/[^\s<>"')\]`\\]+/g;
  const matches = text.match(urlRegex) ?? [];

  // Clean up trailing artifacts that are likely not part of the URL
  return matches
    .map((url) =>
      url
        // Remove trailing escape sequences (\t, \n, \r) - literal backslash+char
        .replace(/\\[tnr]+$/, "")
        // Remove trailing punctuation
        .replace(/[.,;:!?)]+$/, "")
        // Remove trailing markdown code fence markers
        .replace(/`+$/, "")
    )
    .filter((url) => {
      // Filter out malformed URLs that are too short or don't have a domain
      try {
        const parsed = new URL(url);
        return parsed.hostname.includes(".");
      } catch {
        return false;
      }
    });
}

/**
 * Create a generic link from a URL.
 * Initializes metadata (detectedAt, occurrenceCount) for the new link.
 *
 * Note: PR links are detected via branch-based detection (gh pr view),
 * not from chat URL extraction. All chat links are treated as generic.
 *
 * @param url The URL
 * @param timestamp The timestamp when this link was detected (defaults to now)
 */
export function categorizeUrl(url: string, timestamp: number = Date.now()): GenericLink {
  return {
    type: "generic",
    url,
    detectedAt: timestamp,
    occurrenceCount: 1,
  };
}

/**
 * Deduplicate links by URL, keeping the first occurrence.
 */
export function deduplicateLinks<T extends { url: string }>(links: T[]): T[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}
