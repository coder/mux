/**
 * Constants for the post-compaction attachment system.
 */

/** Number of turns between post-compaction attachment injections after the first immediate injection */
export const TURNS_BETWEEN_ATTACHMENTS = 5;

/** Maximum size of file content before truncation (50KB) */
export const MAX_FILE_CONTENT_SIZE = 50_000;

/** Maximum number of edited files to include in attachments */
export const MAX_EDITED_FILES = 10;

/**
 * Maximum total size of the post-compaction context injection.
 *
 * Note: This is a character-based heuristic (provider-agnostic) to avoid large diffs/plan files
 * causing context_exceeded loops even after compaction.
 */
export const MAX_POST_COMPACTION_INJECTION_CHARS = 80_000;

/** Maximum size of plan content included in post-compaction attachments */
export const MAX_POST_COMPACTION_PLAN_CHARS = 30_000;
