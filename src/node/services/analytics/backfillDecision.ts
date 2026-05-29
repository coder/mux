import assert from "node:assert/strict";

export type SyncAction = "full_rebuild" | "incremental" | "noop";

export interface SyncPlan {
  action: SyncAction;
  /** Workspace IDs to ingest (on disk but missing watermark). Only populated when action === "incremental". */
  workspaceIdsToIngest: string[];
  /** Workspace IDs to purge (watermark exists but deleted from disk). Only populated when action === "incremental". */
  workspaceIdsToPurge: string[];
}

export interface SyncPlanInput {
  eventCount: number;
  watermarkCount: number;
  knownWorkspaceIds: Set<string>;
  watermarkWorkspaceIds: Set<string>;
  hasAnyWatermarkAtOrAboveZero: boolean;
}

export function decideSyncPlan(input: SyncPlanInput): SyncPlan {
  assert(
    Number.isInteger(input.eventCount) && input.eventCount >= 0,
    "decideSyncPlan requires a non-negative integer eventCount"
  );
  assert(
    Number.isInteger(input.watermarkCount) && input.watermarkCount >= 0,
    "decideSyncPlan requires a non-negative integer watermarkCount"
  );

  const EMPTY: SyncPlan = {
    action: "noop",
    workspaceIdsToIngest: [],
    workspaceIdsToPurge: [],
  };
  const REBUILD: SyncPlan = {
    action: "full_rebuild",
    workspaceIdsToIngest: [],
    workspaceIdsToPurge: [],
  };

  // No workspaces on disk — purge any stale DB state, or noop if already clean.
  if (input.knownWorkspaceIds.size === 0) {
    return input.watermarkCount > 0 || input.eventCount > 0 ? REBUILD : EMPTY;
  }

  // Events without watermarks → crash during first ingestion; data untrustworthy.
  if (input.watermarkCount === 0 && input.eventCount > 0) {
    return REBUILD;
  }

  // Watermarks claim assistant events were ingested, but events table is empty → DB wiped.
  if (input.eventCount === 0 && input.hasAnyWatermarkAtOrAboveZero) {
    return REBUILD;
  }

  // Compute per-workspace diffs.
  const workspaceIdsToIngest: string[] = [];
  for (const id of input.knownWorkspaceIds) {
    if (!input.watermarkWorkspaceIds.has(id)) {
      workspaceIdsToIngest.push(id);
    }
  }

  const workspaceIdsToPurge: string[] = [];
  for (const id of input.watermarkWorkspaceIds) {
    if (!input.knownWorkspaceIds.has(id)) {
      workspaceIdsToPurge.push(id);
    }
  }

  if (workspaceIdsToIngest.length === 0 && workspaceIdsToPurge.length === 0) {
    return EMPTY;
  }

  return {
    action: "incremental",
    workspaceIdsToIngest,
    workspaceIdsToPurge,
  };
}
