/**
 * Constants for the post-compaction attachment system.
 */

/** Number of turns between post-compaction attachment injections after the first immediate injection */
export const TURNS_BETWEEN_ATTACHMENTS = 5;

/** Maximum size of file content before truncation (50KB) */
export const MAX_FILE_CONTENT_SIZE = 50_000;

/** Maximum number of edited files to include in attachments */
export const MAX_EDITED_FILES = 10;
