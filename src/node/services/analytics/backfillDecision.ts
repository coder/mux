import assert from "node:assert/strict";

export interface BackfillDecisionInput {
  eventCount: number;
  watermarkCount: number;
  sessionWorkspaceCount: number;
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
  // When all workspaces are represented (including zero-event histories),
  // initialization is complete and startup should avoid repeated rebuild loops.
  return input.watermarkCount < input.sessionWorkspaceCount;
}
