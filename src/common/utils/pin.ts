import { isWorkspaceArchived } from "./archive";

/**
 * Determine if a workspace is effectively pinned.
 *
 * A workspace is pinned only when all of the following hold:
 * - `pinnedAt` is set
 * - the workspace is not archived (archive clears pins; stale timestamps are ignored)
 * - it is a root workspace (sub-agents follow their parent and are never pinned themselves)
 *
 * Single definition shared by sorting, age-bucketing, and UI affordances so a stale or
 * malformed `pinnedAt` (e.g. on a child workspace) can never detach a row from its parent.
 */
export function isWorkspacePinned(workspace: {
  pinnedAt?: string;
  archivedAt?: string;
  unarchivedAt?: string;
  parentWorkspaceId?: string;
}): boolean {
  return Boolean(workspace.pinnedAt) && isWorkspacePinnable(workspace);
}

/**
 * Whether the pin/unpin action applies to this workspace at all: only live
 * (non-archived) root chats are pinnable. UI entry points hide the action when
 * this is false; the backend enforces the same rule in setPinned.
 */
export function isWorkspacePinnable(workspace: {
  archivedAt?: string;
  unarchivedAt?: string;
  parentWorkspaceId?: string;
}): boolean {
  if (workspace.parentWorkspaceId) return false;
  return !isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt);
}
