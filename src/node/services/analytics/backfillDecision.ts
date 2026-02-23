import assert from "node:assert/strict";

export interface BackfillDecisionInput {
  eventCount: number;
  watermarkCount: number;
  sessionWorkspaceCount: number;
  hasSessionWorkspaceMissingWatermark: boolean;
  hasWatermarkMissingSessionWorkspace: boolean;
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
    typeof input.hasSessionWorkspaceMissingWatermark === "boolean",
    "shouldRunInitialBackfill requires boolean hasSessionWorkspaceMissingWatermark"
  );
  assert(
    typeof input.hasWatermarkMissingSessionWorkspace === "boolean",
    "shouldRunInitialBackfill requires boolean hasWatermarkMissingSessionWorkspace"
  );
  assert(
    typeof input.hasAnyWatermarkAtOrAboveZero === "boolean",
    "shouldRunInitialBackfill requires boolean hasAnyWatermarkAtOrAboveZero"
  );

  if (input.sessionWorkspaceCount === 0) {
    // No live session workspaces means any persisted analytics rows are stale
    // leftovers from deleted workspaces and should be purged via rebuild.
    return input.watermarkCount > 0 || input.eventCount > 0;
  }

  if (input.watermarkCount === 0) {
    // Event rows can exist without any watermark rows when ingestion is interrupted
    // between writes. Treat missing watermarks as incomplete initialization so
    // startup repairs the partial state on the next boot.
    return true;
  }

  if (input.hasSessionWorkspaceMissingWatermark) {
    // Count parity alone is not enough: stale watermark rows can keep the count
    // equal while still leaving current session workspaces uncovered.
    return true;
  }

  if (input.hasWatermarkMissingSessionWorkspace) {
    // Complementary coverage check: if a watermark points to a workspace that no
    // longer exists on disk, rebuild so stale watermark/event rows are purged.
    return true;
  }

  // Keep this as a defensive fallback in case upstream workspace-id coverage
  // checks regress and start reporting false negatives.
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
