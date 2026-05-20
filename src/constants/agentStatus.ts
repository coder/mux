/**
 * Constants controlling the AI-generated sidebar agent status.
 *
 * The status is produced by the same "small model" path used for workspace
 * title generation. We feed only a trailing window of chat (capped by both
 * message count and token budget) and skip regeneration whenever the input
 * is byte-for-byte unchanged.
 */

/**
 * Per-workspace regen intervals split four ways: streaming workspaces
 * (active) refresh much faster so the user can follow the agent in real
 * time; idle workspaces (no active stream) back off because the chat
 * isn't moving anyway. Either case backs off further when the desktop
 * window is blurred.
 */
export const AGENT_STATUS_ACTIVE_FOCUSED_INTERVAL_MS = 10 * 1000;
export const AGENT_STATUS_ACTIVE_UNFOCUSED_INTERVAL_MS = 30 * 1000;
export const AGENT_STATUS_IDLE_FOCUSED_INTERVAL_MS = 30 * 1000;
export const AGENT_STATUS_IDLE_UNFOCUSED_INTERVAL_MS = 2 * 60 * 1000;

/**
 * How often the scheduler wakes up to scan workspaces. Per-workspace cadence
 * is enforced separately, so this can be small enough to make focus
 * transitions feel snappy without driving redundant work. With
 * AGENT_STATUS_MAX_CONCURRENT=1 the per-tick dispatch naturally smooths load
 * across many workspaces — no separate startup delay needed.
 */
export const AGENT_STATUS_TICK_INTERVAL_MS = 10 * 1000;

/**
 * Retry budget for provider-side status generation failures on an unchanged
 * transcript. A single missed tool call or transient provider hiccup should not
 * freeze the sidebar until the next chat turn. After that, retry on a bounded
 * cooldown so transient provider outages still recover without hammering the
 * small-model path indefinitely.
 */
export const AGENT_STATUS_PROVIDER_FAILURE_RETRY_ATTEMPTS = 2;

/**
 * Cooldowns after the immediate provider-failure retry budget is exhausted.
 * Active streams recover faster because visible status freshness matters most;
 * idle workspaces back off harder because the transcript is not changing.
 */
export const AGENT_STATUS_PROVIDER_FAILURE_ACTIVE_COOLDOWN_MS = 60 * 1000;
export const AGENT_STATUS_PROVIDER_FAILURE_IDLE_COOLDOWN_MS = 5 * 60 * 1000;
export const AGENT_STATUS_PROVIDER_FAILURE_MAX_COOLDOWN_MS = 30 * 60 * 1000;

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
