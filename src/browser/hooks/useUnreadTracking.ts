import { useEffect, useCallback, useRef } from "react";
import type { WorkspaceSelection } from "@/browser/components/ProjectSidebar";
import { getWorkspaceLastReadKey } from "@/common/constants/storage";
import { readPersistedState, updatePersistedState } from "./usePersistedState";

const LEGACY_LAST_READ_KEY = "workspaceLastRead";

/**
 * Track last-read timestamps for workspaces.
 * Individual WorkspaceListItem components compute their own unread state
 * by comparing their recency timestamp with the last-read timestamp.
 *
 * This hook only manages the timestamps, not the unread computation.
 */
export function useUnreadTracking(selectedWorkspace: WorkspaceSelection | null) {
  const didMigrateRef = useRef(false);

  useEffect(() => {
    if (didMigrateRef.current) return;
    didMigrateRef.current = true;

    const legacy = readPersistedState<Record<string, number>>(LEGACY_LAST_READ_KEY, {});
    const entries = Object.entries(legacy);
    if (entries.length === 0) return;

    for (const [workspaceId, timestamp] of entries) {
      if (!Number.isFinite(timestamp)) continue;
      const nextKey = getWorkspaceLastReadKey(workspaceId);
      const existing = readPersistedState<number | undefined>(nextKey, undefined);
      if (existing === undefined) {
        updatePersistedState(nextKey, timestamp);
      }
    }

    updatePersistedState(LEGACY_LAST_READ_KEY, null);
  }, []);

  const markAsRead = useCallback((workspaceId: string) => {
    updatePersistedState(getWorkspaceLastReadKey(workspaceId), Date.now());
  }, []);

  // Mark workspace as read when user switches to it
  useEffect(() => {
    if (selectedWorkspace) {
      markAsRead(selectedWorkspace.workspaceId);
    }
  }, [selectedWorkspace, markAsRead]);
}
