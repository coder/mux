/**
 * Tab system for RightSidebar.
 *
 * Exports:
 * - Registry: Tab configuration and utilities
 * - TabLabels: Label components for each tab type
 */

export {
  TAB_CONFIGS,
  TERMINAL_TAB_CONFIG,
  getTabConfig,
  getTabName,
  getTabContentClassName,
  formatTabDuration,
  type TabConfig,
  type TabRenderContext,
  type TerminalTabRenderContext,
  type TabLabelProps,
  type ReviewStats,
} from "./registry";

export {
  CostsTabLabel,
  ExplorerTabLabel,
  ReviewTabLabel,
  StatsTabLabel,
  TerminalTabLabel,
} from "./TabLabels";
