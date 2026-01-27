import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { getWorkspaceLastReadKey } from "@/common/constants/storage";

/**
 * Hook to determine if a workspace has unread messages.
 * Returns { isUnread, lastReadTimestamp, recencyTimestamp } for flexibility.
 */
export function useWorkspaceUnread(workspaceId: string): {
  isUnread: boolean;
  lastReadTimestamp: number;
  recencyTimestamp: number | null;
} {
  const [lastReadTimestamp] = usePersistedState<number>(getWorkspaceLastReadKey(workspaceId), 0, {
    listener: true,
  });
  const { recencyTimestamp } = useWorkspaceSidebarState(workspaceId);
  const isUnread = recencyTimestamp !== null && recencyTimestamp > lastReadTimestamp;

  return { isUnread, lastReadTimestamp, recencyTimestamp };
}
