import assert from "@/common/utils/assert";
import {
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  HEARTBEAT_MAX_INTERVAL_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
} from "@/constants/heartbeat";

const MS_PER_MINUTE = 60_000;

export const HEARTBEAT_MIN_INTERVAL_MINUTES = HEARTBEAT_MIN_INTERVAL_MS / MS_PER_MINUTE;
export const HEARTBEAT_MAX_INTERVAL_MINUTES = HEARTBEAT_MAX_INTERVAL_MS / MS_PER_MINUTE;
export const HEARTBEAT_DEFAULT_INTERVAL_MINUTES = HEARTBEAT_DEFAULT_INTERVAL_MS / MS_PER_MINUTE;

assert(
  Number.isInteger(HEARTBEAT_MIN_INTERVAL_MINUTES),
  "Heartbeat minimum interval must be a whole number of minutes"
);
assert(
  Number.isInteger(HEARTBEAT_MAX_INTERVAL_MINUTES),
  "Heartbeat maximum interval must be a whole number of minutes"
);
assert(
  Number.isInteger(HEARTBEAT_DEFAULT_INTERVAL_MINUTES),
  "Heartbeat default interval must be a whole number of minutes"
);

/**
 * Convert a stored interval (milliseconds) to a display string in minutes.
 * Falls back to the default when the value is missing or non-finite.
 */
export function formatIntervalMinutes(intervalMs: number | undefined): string {
  if (intervalMs == null || !Number.isFinite(intervalMs)) {
    return String(HEARTBEAT_DEFAULT_INTERVAL_MINUTES);
  }

  const roundedMinutes = Math.round(intervalMs / MS_PER_MINUTE);
  return String(clampIntervalMinutes(roundedMinutes));
}

/**
 * Parse a user-entered string into whole minutes, or `null` if it isn't a valid integer.
 */
export function parseIntervalMinutes(value: string): number | null {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0 || !/^\d+$/.test(trimmedValue)) {
    return null;
  }

  const minutes = Number.parseInt(trimmedValue, 10);
  return Number.isInteger(minutes) ? minutes : null;
}

/**
 * Clamp whole minutes to the allowed heartbeat range.
 */
export function clampIntervalMinutes(minutes: number): number {
  assert(Number.isInteger(minutes), "Heartbeat minutes must be a whole number");
  return Math.min(
    HEARTBEAT_MAX_INTERVAL_MINUTES,
    Math.max(HEARTBEAT_MIN_INTERVAL_MINUTES, minutes)
  );
}

/**
 * Convert whole minutes back to milliseconds for storage.
 */
export function intervalMinutesToMs(minutes: number): number {
  return minutes * MS_PER_MINUTE;
}
