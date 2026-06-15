import assert from "@/common/utils/assert";
import {
  WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MS,
  WORKFLOW_SCHEDULE_MAX_INTERVAL_MS,
  WORKFLOW_SCHEDULE_MIN_INTERVAL_MS,
} from "@/constants/workflowSchedule";

const MS_PER_MINUTE = 60_000;

export const WORKFLOW_SCHEDULE_MIN_INTERVAL_MINUTES =
  WORKFLOW_SCHEDULE_MIN_INTERVAL_MS / MS_PER_MINUTE;
export const WORKFLOW_SCHEDULE_MAX_INTERVAL_MINUTES =
  WORKFLOW_SCHEDULE_MAX_INTERVAL_MS / MS_PER_MINUTE;
export const WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MINUTES =
  WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MS / MS_PER_MINUTE;

assert(
  Number.isInteger(WORKFLOW_SCHEDULE_MIN_INTERVAL_MINUTES),
  "Workflow schedule minimum interval must be a whole number of minutes"
);
assert(
  Number.isInteger(WORKFLOW_SCHEDULE_MAX_INTERVAL_MINUTES),
  "Workflow schedule maximum interval must be a whole number of minutes"
);
assert(
  Number.isInteger(WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MINUTES),
  "Workflow schedule default interval must be a whole number of minutes"
);

export function formatWorkflowScheduleIntervalMinutes(intervalMs: number | undefined): string {
  if (intervalMs == null || !Number.isFinite(intervalMs)) {
    return String(WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MINUTES);
  }

  const roundedMinutes = Math.round(intervalMs / MS_PER_MINUTE);
  return String(clampWorkflowScheduleIntervalMinutes(roundedMinutes));
}

export function parseWorkflowScheduleIntervalMinutes(value: string): number | null {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0 || !/^\d+$/.test(trimmedValue)) {
    return null;
  }

  const minutes = Number.parseInt(trimmedValue, 10);
  return Number.isInteger(minutes) ? minutes : null;
}

export function clampWorkflowScheduleIntervalMinutes(minutes: number): number {
  assert(Number.isInteger(minutes), "Workflow schedule minutes must be a whole number");
  return Math.min(
    WORKFLOW_SCHEDULE_MAX_INTERVAL_MINUTES,
    Math.max(WORKFLOW_SCHEDULE_MIN_INTERVAL_MINUTES, minutes)
  );
}

export interface ParsedWorkflowArgsResult {
  args?: Record<string, unknown>;
  error: string | null;
}

export function parseWorkflowArgs(value: string): ParsedWorkflowArgsResult {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return { error: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedValue);
  } catch {
    return { error: "Workflow args must be valid JSON." };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "Workflow args must be a JSON object." };
  }

  return { args: parsed as Record<string, unknown>, error: null };
}

export function formatWorkflowArgs(args: Record<string, unknown> | null | undefined): string {
  if (args == null || Object.keys(args).length === 0) {
    return "";
  }

  return JSON.stringify(args, null, 2);
}

export function getWorkflowScheduleIntervalValidationError(value: string): string | null {
  const minutes = parseWorkflowScheduleIntervalMinutes(value);
  if (minutes == null) {
    return "Schedule interval must be a whole number of minutes.";
  }

  if (
    minutes < WORKFLOW_SCHEDULE_MIN_INTERVAL_MINUTES ||
    minutes > WORKFLOW_SCHEDULE_MAX_INTERVAL_MINUTES
  ) {
    return `Schedule interval must be between ${WORKFLOW_SCHEDULE_MIN_INTERVAL_MINUTES} and ${WORKFLOW_SCHEDULE_MAX_INTERVAL_MINUTES} minutes.`;
  }

  return null;
}

export function workflowScheduleIntervalMinutesToMs(minutes: number): number {
  assert(Number.isInteger(minutes), "Workflow schedule minutes must be a whole number");
  return minutes * MS_PER_MINUTE;
}
