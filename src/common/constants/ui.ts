/**
 * UI-related constants shared across components
 */

/**
 * Emoji used for compacted/start-here functionality throughout the app.
 * Used in:
 * - AssistantMessage compacted badge
 * - Start Here button (plans and assistant messages)
 */
export const COMPACTED_EMOJI = "📦";

/**
 * Auto-compaction threshold bounds (percentage)
 * MIN: Allow any value - user can choose aggressive compaction if desired
 * MAX: Cap at 90% to leave buffer before hitting context limit
 */
export const AUTO_COMPACTION_THRESHOLD_MIN = 0;
export const AUTO_COMPACTION_THRESHOLD_MAX = 90;

/**
 * Default auto-compaction threshold percentage (50-90 range)
 * Applied when creating new workspaces
 */
export const DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT = 70;

/**
 * Default threshold as decimal for calculations (0.7 = 70%)
 */
export const DEFAULT_AUTO_COMPACTION_THRESHOLD = DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT / 100;

/**
 * Default word target for compaction summaries
 */
export const DEFAULT_COMPACTION_WORD_TARGET = 2000;

/**
 * Approximate ratio of tokens to words (tokens per word)
 * Used for converting between word counts and token counts
 */
export const WORDS_TO_TOKENS_RATIO = 1.3;

/**
 * Force-compaction token buffer.
 * When auto-compaction is enabled and live usage shows this many tokens or fewer
 * remaining in the context window, force a compaction immediately.
 * Set to 2x the expected compaction output size to ensure room for the summary.
 */
export const FORCE_COMPACTION_TOKEN_BUFFER = Math.round(
  2 * DEFAULT_COMPACTION_WORD_TARGET * WORDS_TO_TOKENS_RATIO
); // = 5200 tokens

/**
 * Duration (ms) to show "copied" feedback after copying to clipboard
 */
export const COPY_FEEDBACK_DURATION_MS = 2000;
