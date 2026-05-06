/**
 * Constants controlling the AI-generated sidebar agent status.
 *
 * The status is produced by the same "small model" path used for workspace
 * title generation (see {@link NAME_GEN_PREFERRED_MODELS}). To keep cost
 * predictable, we only feed the model a trailing window of the chat
 * transcript — capped both by message count and by token budget — and we
 * skip regeneration whenever the input is byte-for-byte unchanged.
 */

/**
 * How often a per-workspace status is regenerated when the desktop window is
 * focused. Smaller intervals make the sidebar feel responsive to the user
 * who is actively watching it.
 */
export const AGENT_STATUS_FOCUSED_INTERVAL_MS = 30 * 1000;

/**
 * How often a per-workspace status is regenerated when the desktop window is
 * blurred. Larger intervals respect the fact that the user isn't watching,
 * while still picking up changes for any user who switches back to mux.
 */
export const AGENT_STATUS_UNFOCUSED_INTERVAL_MS = 2 * 60 * 1000;

/**
 * How often the scheduler wakes up to scan workspaces. Per-workspace cadence
 * is enforced by comparing now() against each workspace's `nextEligibleAt`,
 * so this can be small enough to make focus transitions feel snappy without
 * causing redundant work — the cadence intervals above are the upper bound
 * on actual generation frequency.
 */
export const AGENT_STATUS_TICK_INTERVAL_MS = 10 * 1000;

/**
 * Delay before the scheduler runs its first pass after startup. Lets initial
 * chat replay and metadata bootstrap settle, and avoids a thundering herd of
 * model calls during launch.
 */
export const AGENT_STATUS_STARTUP_DELAY_MS = 30 * 1000;

/**
 * Token budget for the trailing chat-transcript window we feed into the
 * small model. Capped to keep cost bounded across long chats.
 */
export const AGENT_STATUS_MAX_TRANSCRIPT_TOKENS = 8000;

/**
 * Cap on the number of trailing messages we ever pull off disk before token
 * trimming kicks in. Bounds disk I/O for very chatty workspaces.
 */
export const AGENT_STATUS_MAX_TRAILING_MESSAGES = 80;

/**
 * Cap on per-message text length (post-trim) before we feed it to the
 * tokenizer. Tool outputs and assistant turns can be enormous; we already
 * have a token budget, but a per-message cap protects against pathological
 * single messages that would otherwise burn the entire budget.
 */
export const AGENT_STATUS_MAX_MESSAGE_CHARS = 4000;

/**
 * Maximum number of concurrent model invocations across all workspaces.
 * Keep this small so a multi-workspace sweep doesn't spike provider bills
 * or trip rate limits.
 */
export const AGENT_STATUS_MAX_CONCURRENT = 1;
