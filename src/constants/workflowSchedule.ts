/**
 * Per-workspace scheduled workflow runs (WorkflowSchedulerService).
 *
 * Unlike heartbeats (idle-recency gated, chat-prompt based), workflow
 * schedules are wall-clock timers: a run is due when `intervalMs` has elapsed
 * since the last dispatched run, regardless of workspace activity.
 */
export const WORKFLOW_SCHEDULE_MIN_INTERVAL_MS = 60 * 1000;
export const WORKFLOW_SCHEDULE_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Default cadence offered by the configuration UI for new schedules. */
export const WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
/** How often the scheduler scans config for due schedules. */
export const WORKFLOW_SCHEDULE_CHECK_INTERVAL_MS = 30 * 1000;
/** Maximum time a scheduled compact context preparation may occupy before the run is skipped. */
export const WORKFLOW_SCHEDULE_CONTEXT_PREPARATION_TIMEOUT_MS = 30 * 60 * 1000;

export const WORKFLOW_SCHEDULE_CONTEXT_MODE_VALUES = ["normal", "compact", "reset"] as const;
export type WorkflowScheduleContextMode = (typeof WORKFLOW_SCHEDULE_CONTEXT_MODE_VALUES)[number];
export const WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE: WorkflowScheduleContextMode = "normal";

export const WORKFLOW_SCHEDULE_TARGET_TYPES = ["current-workspace", "new-workspace"] as const;
export type WorkflowScheduleTargetType = (typeof WORKFLOW_SCHEDULE_TARGET_TYPES)[number];
