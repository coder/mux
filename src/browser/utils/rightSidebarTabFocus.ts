import {
  getDefaultRightSidebarLayoutState,
  parseRightSidebarLayoutState,
  selectOrAddTab,
  type RightSidebarLayoutState,
} from "@/browser/utils/rightSidebarLayout";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { isTabType, type TabType } from "@/browser/types/rightSidebar";
import { getRightSidebarLayoutKey, RIGHT_SIDEBAR_TAB_KEY } from "@/common/constants/storage";

export function focusRightSidebarTab(workspaceId: string, tab: TabType): void {
  updateRightSidebarLayout(workspaceId, (state) => selectOrAddTab(state, tab));
}

export function readRightSidebarLayout(workspaceId: string): RightSidebarLayoutState {
  const fallback = getRightSidebarTabFallback();
  const raw = readPersistedState(
    getRightSidebarLayoutKey(workspaceId),
    getDefaultRightSidebarLayoutState(fallback)
  );
  return parseRightSidebarLayoutState(raw, fallback);
}

export function updateRightSidebarLayout(
  workspaceId: string,
  updater: (state: RightSidebarLayoutState) => RightSidebarLayoutState
): void {
  const fallback = getRightSidebarTabFallback();
  const defaultLayout = getDefaultRightSidebarLayoutState(fallback);

  updatePersistedState<RightSidebarLayoutState>(
    getRightSidebarLayoutKey(workspaceId),
    (prev) => updater(parseRightSidebarLayoutState(prev, fallback)),
    defaultLayout
  );
}

export function getRightSidebarTabFallback(): TabType {
  const raw = readPersistedState<string>(RIGHT_SIDEBAR_TAB_KEY, "costs");
  return isTabType(raw) ? raw : "costs";
}
