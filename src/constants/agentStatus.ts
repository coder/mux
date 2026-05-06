/**
 * Constants controlling the AI-generated sidebar agent status.
 *
 * The status is produced by the same "small model" path used for workspace
 * title generation. We feed only a trailing window of chat (capped by both
 * message count and token budget) and skip regeneration whenever the input
 * is byte-for-byte unchanged.
 */

/** Per-workspace regen interval when the desktop window is focused. */
export const AGENT_STATUS_FOCUSED_INTERVAL_MS = 30 * 1000;

/** Per-workspace regen interval when the desktop window is blurred. */
export const AGENT_STATUS_UNFOCUSED_INTERVAL_MS = 2 * 60 * 1000;

/**
 * How often the scheduler wakes up to scan workspaces. Per-workspace cadence
 * is enforced separately, so this can be small enough to make focus
 * transitions feel snappy without driving redundant work.
 */
export const AGENT_STATUS_TICK_INTERVAL_MS = 10 * 1000;

/**
 * Delay before the first scheduler pass after startup. Lets initial chat
 * replay and metadata bootstrap settle, and avoids a thundering herd of
 * model calls during launch.
 */
export const AGENT_STATUS_STARTUP_DELAY_MS = 30 * 1000;

/** Token budget for the trailing chat-transcript window we feed the model. */
export const AGENT_STATUS_MAX_TRANSCRIPT_TOKENS = 8000;

/** Cap on the number of trailing messages we pull off disk before token trimming. */
export const AGENT_STATUS_MAX_TRAILING_MESSAGES = 80;

/**
 * Cap on per-message text length before tokenization. Bounds pathological
 * single messages (huge tool outputs) that would otherwise burn the budget.
 */
export const AGENT_STATUS_MAX_MESSAGE_CHARS = 4000;

/**
 * Maximum concurrent model invocations across all workspaces. Keep small so
 * a multi-workspace sweep doesn't spike provider bills or rate limits.
 */
export const AGENT_STATUS_MAX_CONCURRENT = 1;
