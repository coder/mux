/**
 * Per-workspace scheduled workflow runs (WorkflowSchedulerService).
 *
 * Unlike heartbeats (idle-recency gated, chat-prompt based), workflow
 * schedules are wall-clock timers: a run is due when `intervalMs` has elapsed
 * since the last dispatched run, regardless of workspace activity.
 */
export const WORKFLOW_SCHEDULE_MIN_INTERVAL_MS = 60 * 1000;
export const WORKFLOW_SCHEDULE_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How often the scheduler scans config for due schedules. */
export const WORKFLOW_SCHEDULE_CHECK_INTERVAL_MS = 30 * 1000;
