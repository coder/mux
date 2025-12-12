/**
 * Types for code review system
 */

/**
 * Individual hunk within a file diff
 */
export interface DiffHunk {
  /** Unique identifier for this hunk (hash of file path + line ranges) */
  id: string;
  /** Path to the file relative to workspace root */
  filePath: string;
  /** Starting line number in old file */
  oldStart: number;
  /** Number of lines in old file */
  oldLines: number;
  /** Starting line number in new file */
  newStart: number;
  /** Number of lines in new file */
  newLines: number;
  /** Diff content (lines starting with +/-/space) */
  content: string;
  /** Hunk header line (e.g., "@@ -1,5 +1,6 @@") */
  header: string;
  /** Change type from parent file */
  changeType?: "added" | "deleted" | "modified" | "renamed";
  /** Old file path (if renamed) */
  oldPath?: string;
}

/**
 * Parsed file diff containing multiple hunks
 */
export interface FileDiff {
  /** Path to the file relative to workspace root */
  filePath: string;
  /** Old file path (different if renamed) */
  oldPath?: string;
  /** Type of change */
  changeType: "added" | "deleted" | "modified" | "renamed";
  /** Whether this is a binary file */
  isBinary: boolean;
  /** Hunks in this file */
  hunks: DiffHunk[];
}

/**
 * Read state for a single hunk
 */
export interface HunkReadState {
  /** ID of the hunk */
  hunkId: string;
  /** Whether this hunk has been marked as read */
  isRead: boolean;
  /** Timestamp when read state was last updated */
  timestamp: number;
}

/**
 * Workspace review state (persisted to localStorage)
 */
export interface ReviewState {
  /** Workspace ID this review belongs to */
  workspaceId: string;
  /** Read state keyed by hunk ID */
  readState: Record<string, HunkReadState>;
  /** Timestamp of last update */
  lastUpdated: number;
}

/**
 * Filter options for review panel
 */
export interface ReviewFilters {
  /** Whether to show hunks marked as read */
  showReadHunks: boolean;
  /** File path filter (regex or glob pattern) */
  filePathFilter?: string;
  /** Base reference to diff against (e.g., "HEAD", "main", "origin/main") */
  diffBase: string;
  /** Whether to include uncommitted changes (staged + unstaged) in the diff */
  includeUncommitted: boolean;
}

/**
 * Review statistics
 */
export interface ReviewStats {
  /** Total number of hunks */
  total: number;
  /** Number of hunks marked as read */
  read: number;
  /** Number of unread hunks */
  unread: number;
}

/**
 * Status of a review
 * - pending: In banner, not attached to chat input
 * - attached: Currently attached to chat input draft
 * - checked: Marked as done (after being sent)
 */
export type ReviewStatus = "pending" | "attached" | "checked";

/**
 * Structured data for a review note.
 * Passed from DiffRenderer when user creates a review.
 * Stored as-is for rich UI display, formatted to message only when sending to chat.
 */
export interface ReviewNoteData {
  /** File path being reviewed */
  filePath: string;
  /** Line range (e.g., "42" or "42-45") */
  lineRange: string;

  /**
   * Human-readable selected code included in the message payload.
   * Historically this included embedded line numbers; keep for backwards compatibility.
   */
  selectedCode: string;

  /**
   * Raw diff snippet for UI rendering (lines start with + / - / space).
   * When present, the UI should prefer this for consistent syntax highlighting.
   */
  selectedDiff?: string;

  /** Starting old line number for rendering selectedDiff (if present). */
  oldStart?: number;
  /** Starting new line number for rendering selectedDiff (if present). */
  newStart?: number;

  /** User's review comment */
  userNote: string;
}

/**
 * A single review note
 * Created when user adds a review note from the diff viewer
 */
export interface Review {
  /** Unique identifier */
  id: string;
  /** Structured review data for rich UI display */
  data: ReviewNoteData;
  /** Current status */
  status: ReviewStatus;
  /** Timestamp when created */
  createdAt: number;
  /** Timestamp when status changed (checked/unchecked) */
  statusChangedAt?: number;
}

/**
 * Persisted state for reviews (per workspace)
 * Contains reviews in all states: pending, attached, and checked
 */
export interface ReviewsState {
  /** Workspace ID */
  workspaceId: string;
  /** All reviews keyed by ID */
  reviews: Record<string, Review>;
  /** Last update timestamp */
  lastUpdated: number;
}

/**
 * Format a ReviewNoteData into the message format for the model.
 * Used when preparing reviews for sending to chat.
 */
export function formatReviewForModel(data: ReviewNoteData): string {
  return `<review>\nRe ${data.filePath}:${data.lineRange}\n\`\`\`\n${data.selectedCode}\n\`\`\`\n> ${data.userNote.trim()}\n</review>`;
}
