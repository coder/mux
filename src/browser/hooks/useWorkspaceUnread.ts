import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { getWorkspaceLastReadKey } from "@/common/constants/storage";

/**
 * Hook to determine if a workspace has unread messages.
 * Returns { isUnread, lastReadTimestamp, recencyTimestamp } for flexibility.
 */
export function useWorkspaceUnread(workspaceId: string): {
  isUnread: boolean;
  lastReadTimestamp: number | null;
  recencyTimestamp: number | null;
} {
  // Missing lastRead means this workspace has no persisted read baseline yet.
  // Treat that as "implicitly read" until we observe an explicit read event,
  // instead of coercing to epoch (0) which marks legacy workspaces unread forever.
  const [lastReadTimestamp] = usePersistedState<number | null>(
    getWorkspaceLastReadKey(workspaceId),
    null,
    {
      listener: true,
    }
  );
  const { recencyTimestamp } = useWorkspaceSidebarState(workspaceId);
  const isUnread =
    recencyTimestamp !== null && lastReadTimestamp !== null && recencyTimestamp > lastReadTimestamp;

  return { isUnread, lastReadTimestamp, recencyTimestamp };
}
