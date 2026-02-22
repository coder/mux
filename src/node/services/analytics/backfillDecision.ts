import assert from "node:assert/strict";

export interface BackfillDecisionInput {
  eventCount: number;
  watermarkCount: number;
  hasSessionDirectories: boolean;
}

export function shouldRunInitialBackfill(input: BackfillDecisionInput): boolean {
  assert(
    Number.isInteger(input.eventCount) && input.eventCount >= 0,
    "shouldRunInitialBackfill requires a non-negative integer eventCount"
  );
  assert(
    Number.isInteger(input.watermarkCount) && input.watermarkCount >= 0,
    "shouldRunInitialBackfill requires a non-negative integer watermarkCount"
  );
  assert(
    typeof input.hasSessionDirectories === "boolean",
    "shouldRunInitialBackfill requires a boolean hasSessionDirectories"
  );

  // If ingest watermarks already exist, initialization has happened before even
  // when the workspace currently has zero assistant events (for example, a
  // history containing only non-billable messages). Rebuilding on every startup
  // would repeatedly rescan all sessions and waste work.
  if (input.eventCount > 0 || input.watermarkCount > 0) {
    return false;
  }

  return input.hasSessionDirectories;
}
