/**
 * Determine if a workspace is archived based on timestamps.
 * A workspace is archived if archivedAt exists and is more recent than unarchivedAt.
 *
 * @param archivedAt - ISO timestamp when workspace was archived
 * @param unarchivedAt - ISO timestamp when workspace was unarchived
 * @returns true if workspace is currently archived
 */
export function isWorkspaceArchived(archivedAt?: string, unarchivedAt?: string): boolean {
  if (!archivedAt) return false;
  if (!unarchivedAt) return true;
  return new Date(archivedAt).getTime() > new Date(unarchivedAt).getTime();
}
