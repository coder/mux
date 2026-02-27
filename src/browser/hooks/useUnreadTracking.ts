import { useEffect, useCallback, useRef } from "react";
import type { WorkspaceSelection } from "@/browser/components/ProjectSidebar/ProjectSidebar";
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
export function useUnreadTracking(
  selectedWorkspace: WorkspaceSelection | null,
  currentWorkspaceId: string | null
) {
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

  const selectedWorkspaceId = selectedWorkspace?.workspaceId ?? null;
  const visibleSelectedWorkspaceId =
    selectedWorkspaceId != null && currentWorkspaceId === selectedWorkspaceId
      ? selectedWorkspaceId
      : null;

  const markSelectedAsReadIfVisible = useCallback(() => {
    if (visibleSelectedWorkspaceId == null) return;
    markAsRead(visibleSelectedWorkspaceId);
  }, [visibleSelectedWorkspaceId, markAsRead]);

  // Mark as read when visibility changes (workspace selected + chat route active).
  useEffect(() => {
    markSelectedAsReadIfVisible();
  }, [markSelectedAsReadIfVisible]);

  // Mark as read when window regains focus — only when chat is visible.
  useEffect(() => {
    window.addEventListener("focus", markSelectedAsReadIfVisible);
    return () => window.removeEventListener("focus", markSelectedAsReadIfVisible);
  }, [markSelectedAsReadIfVisible]);
}
