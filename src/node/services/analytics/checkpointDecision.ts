import assert from "node:assert/strict";

import type { SyncAction } from "./backfillDecision";

/**
 * Pure predicate: should we issue a CHECKPOINT after this sync?
 *
 * full_rebuild always truncates tables, so always checkpoint even if nothing
 * was re-ingested. incremental only needs a checkpoint when rows were actually
 * written or deleted.
 */
export function shouldCheckpointAfterSync(
  action: SyncAction,
  workspacesIngested: number,
  workspacesPurged: number
): boolean {
  assert(
    Number.isInteger(workspacesIngested) && workspacesIngested >= 0,
    "shouldCheckpointAfterSync requires non-negative integer workspacesIngested"
  );
  assert(
    Number.isInteger(workspacesPurged) && workspacesPurged >= 0,
    "shouldCheckpointAfterSync requires non-negative integer workspacesPurged"
  );

  if (action === "full_rebuild") {
    return true;
  }

  return action === "incremental" && (workspacesIngested > 0 || workspacesPurged > 0);
}
