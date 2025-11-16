import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

/**
 * Time threshold for considering a workspace "old" (24 hours in milliseconds)
 */
const OLD_WORKSPACE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Format the old workspace threshold for display.
 * Returns a human-readable string like "1 day", "2 hours", etc.
 */
export function formatOldWorkspaceThreshold(): string {
  const hours = OLD_WORKSPACE_THRESHOLD_MS / (60 * 60 * 1000);
  if (hours >= 24) {
    const days = hours / 24;
    return days === 1 ? "1 day" : `${days} days`;
  }
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/**
 * Partition workspaces into recent and old based on recency timestamp.
 * Workspaces with no activity in the last 24 hours are considered "old".
 * Always shows at least one workspace in the recent section (the most recent one).
 */
export function partitionWorkspacesByAge(
  workspaces: FrontendWorkspaceMetadata[],
  workspaceRecency: Record<string, number>
): {
  recent: FrontendWorkspaceMetadata[];
  old: FrontendWorkspaceMetadata[];
} {
  if (workspaces.length === 0) {
    return { recent: [], old: [] };
  }

  const now = Date.now();
  const recent: FrontendWorkspaceMetadata[] = [];
  const old: FrontendWorkspaceMetadata[] = [];

  for (const workspace of workspaces) {
    const recencyTimestamp = workspaceRecency[workspace.id] ?? 0;
    const age = now - recencyTimestamp;

    if (age >= OLD_WORKSPACE_THRESHOLD_MS) {
      old.push(workspace);
    } else {
      recent.push(workspace);
    }
  }

  // Always show at least one workspace - move the most recent from old to recent
  if (recent.length === 0 && old.length > 0) {
    recent.push(old.shift()!);
  }

  return { recent, old };
}
