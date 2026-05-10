/**
 * Tab system for RightSidebar.
 *
 * Lightweight tab metadata lives in `tabConfig.ts`; React label/panel renderers
 * live in `tabRegistry.tsx`. This split keeps shared helpers and the VS Code
 * extension from eagerly importing desktop-only panel code while still giving
 * the desktop sidebar one typed registry surface.
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
