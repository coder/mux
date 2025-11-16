import { useEffect, useCallback } from "react";
import type { WorkspaceSelection } from "@/browser/components/ProjectSidebar";
import { usePersistedState } from "./usePersistedState";

/**
 * Track last-read timestamps for workspaces.
 * Individual WorkspaceListItem components compute their own unread state
 * by comparing their recency timestamp with the last-read timestamp.
 *
 * This hook only manages the timestamps, not the unread computation.
 */
export function useUnreadTracking(selectedWorkspace: WorkspaceSelection | null) {
  // Store all last-read timestamps in a single Record
  // Format: { [workspaceId]: timestamp }
  const [lastReadTimestamps, setLastReadTimestamps] = usePersistedState<Record<string, number>>(
    "workspaceLastRead",
    {},
    { listener: true } // Enable cross-component/tab sync
  );

  // Mark workspace as read by storing current timestamp
  const markAsRead = useCallback(
    (workspaceId: string) => {
      setLastReadTimestamps((prev) => ({
        ...prev,
        [workspaceId]: Date.now(),
      }));
    },
    [setLastReadTimestamps]
  );

  // Mark workspace as read when user switches to it
  useEffect(() => {
    if (selectedWorkspace) {
      markAsRead(selectedWorkspace.workspaceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkspace?.workspaceId, markAsRead]);

  // Manual toggle function for clicking the indicator
  const onToggleUnread = useCallback(
    (workspaceId: string) => {
      const lastRead = lastReadTimestamps[workspaceId] ?? 0;

      if (lastRead > 0) {
        // Mark as unread by setting timestamp to 0 (older than any message)
        setLastReadTimestamps((prev) => ({
          ...prev,
          [workspaceId]: 0,
        }));
      } else {
        // Mark as read
        markAsRead(workspaceId);
      }
    },
    [lastReadTimestamps, markAsRead, setLastReadTimestamps]
  );

  return {
    lastReadTimestamps,
    onToggleUnread,
  };
}
