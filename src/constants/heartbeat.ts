export const HEARTBEAT_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const HEARTBEAT_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const HEARTBEAT_DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
export const HEARTBEAT_MAX_MESSAGE_LENGTH = 1_000;

// Keep the idle-duration lead-in fixed so custom workspace heartbeats only override the
// instruction body, not the scheduler-generated runtime context.
export const HEARTBEAT_DEFAULT_MESSAGE_BODY =
  "Check in on the current state of this workspace — review any pending work, check for stale context, and determine if any action is needed. If everything looks good, briefly confirm the workspace status.";
