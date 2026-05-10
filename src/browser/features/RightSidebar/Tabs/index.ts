/**
 * Tab system for RightSidebar.
 *
 * The single source of truth for tab definitions lives in `tabRegistry.tsx`.
 * Adding/renaming/removing a non-terminal tab should require touching ONLY
 * that file. This barrel re-exports the public surface for convenience.
 */

export {
  TAB_REGISTRY,
  BASE_TAB_IDS,
  isBaseTabId,
  getTabRegistration,
  getDefaultLayoutTabIds,
  getOrderedBaseTabIds,
  type BaseTabType,
  type TabRegistration,
  type TabPanelContext,
  type TabLabelContext,
  type ReviewStats,
} from "./tabRegistry";

export { getTabName, getTabContentClassName } from "./registry";

// Label components are still exported for legacy/test consumers.
export {
  StatsTabLabel,
  OutputTabLabel,
  ReviewTabLabel,
  TerminalTabLabel,
  InstructionsTabLabel,
  BrowserTabLabel,
  DebugTabLabel,
  DesktopTabLabel,
} from "./TabLabels";
