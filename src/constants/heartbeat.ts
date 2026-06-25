export const HEARTBEAT_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const HEARTBEAT_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const HEARTBEAT_DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

export const HEARTBEAT_CONTEXT_MODE_VALUES = ["normal", "compact", "reset"] as const;
export type HeartbeatContextMode = (typeof HEARTBEAT_CONTEXT_MODE_VALUES)[number];
export const HEARTBEAT_DEFAULT_CONTEXT_MODE: HeartbeatContextMode = "normal";

export const HEARTBEAT_RESET_BOUNDARY_MESSAGE =
  "Heartbeat context reset. Earlier chat history is preserved on disk, but future requests will start from this boundary without generating a compaction summary.";

// Keep the idle-duration lead-in fixed so custom workspace heartbeats only override the
// instruction body, not the scheduler-generated runtime context.
export const HEARTBEAT_DEFAULT_MESSAGE_BODY =
  "Check in on the current state of this workspace — review any pending work, check for stale context, and determine if any action is needed. If everything looks good, briefly confirm the workspace status.";

const HEARTBEAT_MS_PER_MINUTE = 60 * 1000;
const HEARTBEAT_MS_PER_HOUR = 60 * HEARTBEAT_MS_PER_MINUTE;

/**
 * Human-readable heartbeat cadence, e.g. "30 minutes", "2 hours", "1 hour".
 *
 * Total over any positive interval: whole hours render as hours; everything else
 * rounds to the nearest minute. Rounding (rather than a raw "<ms> ms" fallback) keeps
 * an in-range but non-whole-minute intervalMs from leaking a millisecond count into the
 * UI/summary. Shared by the backend result summary (src/node/services/tools/heartbeat.ts)
 * and the HeartbeatToolCall card so the two never drift.
 */
export function formatHeartbeatInterval(intervalMs: number): string {
  if (intervalMs % HEARTBEAT_MS_PER_HOUR === 0) {
    const hours = intervalMs / HEARTBEAT_MS_PER_HOUR;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const minutes = Math.max(1, Math.round(intervalMs / HEARTBEAT_MS_PER_MINUTE));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** Compact cadence for the header pill, e.g. "30m", "2h". Rounds like {@link formatHeartbeatInterval}. */
export function formatHeartbeatIntervalShort(intervalMs: number): string {
  if (intervalMs % HEARTBEAT_MS_PER_HOUR === 0) {
    return `${intervalMs / HEARTBEAT_MS_PER_HOUR}h`;
  }
  return `${Math.max(1, Math.round(intervalMs / HEARTBEAT_MS_PER_MINUTE))}m`;
}
