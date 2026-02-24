import { isWorkspaceArchived } from "./archive";

export interface ProjectWorkspaceCounts {
  activeCount: number;
  archivedCount: number;
}

/**
 * Compute active vs archived workspace counts from a project's workspace config entries.
 * Used by both backend (removal policy) and frontend (sidebar eligibility).
 */
export function getProjectWorkspaceCounts(
  workspaces: ReadonlyArray<{ archivedAt?: string; unarchivedAt?: string }>
): ProjectWorkspaceCounts {
  let archivedCount = 0;
  for (const ws of workspaces) {
    if (isWorkspaceArchived(ws.archivedAt, ws.unarchivedAt)) archivedCount += 1;
  }
  return { activeCount: workspaces.length - archivedCount, archivedCount };
}
