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
 * Too low risks frequent interruptions; too high risks hitting context limits
 */
export const AUTO_COMPACTION_THRESHOLD_MIN = 50;
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
 * Duration (ms) to show "copied" feedback after copying to clipboard
 */
export const COPY_FEEDBACK_DURATION_MS = 2000;
