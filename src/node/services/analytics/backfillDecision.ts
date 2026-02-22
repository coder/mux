import assert from "node:assert/strict";

export interface BackfillDecisionInput {
  eventCount: number;
  watermarkCount: number;
  sessionWorkspaceCount: number;
  hasAnyWatermarkAtOrAboveZero: boolean;
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
    Number.isInteger(input.sessionWorkspaceCount) && input.sessionWorkspaceCount >= 0,
    "shouldRunInitialBackfill requires a non-negative integer sessionWorkspaceCount"
  );
  assert(
    typeof input.hasAnyWatermarkAtOrAboveZero === "boolean",
    "shouldRunInitialBackfill requires boolean hasAnyWatermarkAtOrAboveZero"
  );

  if (input.sessionWorkspaceCount === 0) {
    return false;
  }

  if (input.watermarkCount === 0) {
    // Event rows can exist without any watermark rows when ingestion is interrupted
    // between writes. Treat missing watermarks as incomplete initialization so
    // startup repairs the partial state on the next boot.
    return true;
  }

  // Watermark rows are keyed by workspace id, so a count lower than the number
  // of session workspaces means a previous rebuild was only partially completed.
  if (input.watermarkCount < input.sessionWorkspaceCount) {
    return true;
  }

  if (input.eventCount > 0) {
    return false;
  }

  // Empty events + complete watermark coverage is usually a legitimate zero-event
  // history. Rebuild only if any watermark proves assistant events were ingested
  // before (last_sequence >= 0), which indicates the events table was wiped.
  return input.hasAnyWatermarkAtOrAboveZero;
}
