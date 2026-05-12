import {
  getDefaultRightSidebarLayoutState,
  parseRightSidebarLayoutState,
  selectOrAddTab,
} from "@/browser/utils/rightSidebarLayout";
import { getRightSidebarLayoutKey, RIGHT_SIDEBAR_TAB_KEY } from "@/common/constants/storage";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { isTabType, type TabType } from "@/browser/types/rightSidebar";

/**
 * Programmatically reveal the right-sidebar Instructions tab for a workspace.
 * Used by the ChatInput decoration so clicking the inline preview brings the
 * user to the editor without having to know about layout helpers.
 *
 * If the tab is already present anywhere in the layout, it's focused in its
 * current tabset; otherwise it's added to the focused tabset.
 */
export function focusInstructionsTab(workspaceId: string): void {
  const fallback = getRightSidebarTabFallback();
  const defaultLayout = getDefaultRightSidebarLayoutState(fallback);
  updatePersistedState(
    getRightSidebarLayoutKey(workspaceId),
    (prev) => selectOrAddTab(parseRightSidebarLayoutState(prev, fallback), "instructions"),
    defaultLayout
  );
}

function getRightSidebarTabFallback(): TabType {
  const raw = readPersistedState<string>(RIGHT_SIDEBAR_TAB_KEY, "costs");
  return isTabType(raw) ? raw : "costs";
}
