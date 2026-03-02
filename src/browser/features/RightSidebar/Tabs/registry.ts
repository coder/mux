/**
 * Tab Registry - Centralized configuration for RightSidebar tabs.
 *
 * Each tab type defines:
 * - name: Display name for the tab
 * - contentClassName: CSS classes for the tab panel container
 * - keepAlive: Whether the tab should remain mounted while hidden
 * - featureFlag: Optional feature flag key required to show the tab
 *
 * This keeps per-tab decisions out of RightSidebar.tsx and avoids switch statements.
 */

import type { TabType } from "@/browser/types/rightSidebar";
import { formatDuration } from "@/common/utils/formatDuration";
import type { ReviewNoteData } from "@/common/types/review";

/** Stats reported by ReviewPanel for tab display */
export interface ReviewStats {
  total: number;
  read: number;
}

/** Context passed to tab renderers */
export interface TabRenderContext {
  workspaceId: string;
  workspacePath: string;
  projectPath: string;
  isCreating: boolean;
  focusTrigger: number;
  onReviewNote?: (data: ReviewNoteData) => void;
  onReviewStatsChange: (stats: ReviewStats | null) => void;
  /** Whether this tab is currently visible/active */
  visible: boolean;
}

/** Context for terminal tab rendering */
export interface TerminalTabRenderContext extends TabRenderContext {
  tabType: TabType;
  onTitleChange: (title: string) => void;
}

/** Label props passed to label renderers */
export interface TabLabelProps {
  /** Cost in dollars for the current session (costs tab) */
  sessionCost?: number | null;
  /** Review panel stats (review tab) */
  reviewStats?: ReviewStats | null;
  /** Session duration in ms (stats tab) */
  sessionDuration?: number | null;
  /** For terminal tabs: dynamic title from OSC sequences */
  terminalTitle?: string;
  /** For terminal tabs: index within the tabset (for "Terminal 2" etc) */
  terminalIndex?: number;
  /** Callback when pop-out button clicked */
  onPopOut?: () => void;
  /** Callback when close button clicked */
  onClose?: () => void;
}

/** Configuration for a single tab type */
export interface TabConfig {
  /** Base display name (e.g., "Costs", "Review", "Terminal") */
  name: string;

  /** CSS classes for the tab panel content area */
  contentClassName: string;

  /**
   * Whether this tab should be rendered when hidden (keep-alive).
   * Most tabs only render when active. Terminal tabs stay mounted to preserve state.
   */
  keepAlive?: boolean;

  /**
   * Whether this tab requires a feature flag to be shown.
   * Returns the feature flag key, or undefined if always available.
   */
  featureFlag?: string;
}

/** Static tab configurations (non-terminal tabs) */
export const TAB_CONFIGS: Record<"costs" | "review" | "explorer" | "stats" | "output", TabConfig> =
  {
    costs: {
      name: "Costs",
      contentClassName: "overflow-y-auto p-[15px]",
    },
    review: {
      name: "Review",
      contentClassName: "overflow-y-auto p-0",
    },
    explorer: {
      name: "Explorer",
      contentClassName: "overflow-y-auto p-0",
    },
    stats: {
      name: "Stats",
      contentClassName: "overflow-y-auto p-[15px]",
      featureFlag: "statsTab",
    },
    output: {
      name: "Output",
      contentClassName: "overflow-hidden p-0",
    },
  };

/** Terminal tab configuration */
export const TERMINAL_TAB_CONFIG: TabConfig = {
  name: "Terminal",
  contentClassName: "overflow-hidden p-0",
  keepAlive: true,
};

/** File viewer tab configuration */
export const FILE_TAB_CONFIG: TabConfig = {
  name: "File",
  contentClassName: "overflow-auto p-0",
  keepAlive: false, // No need to keep rendered when hidden
};

/** Get config for a tab type */
export function getTabConfig(tab: TabType): TabConfig {
  if (
    tab === "costs" ||
    tab === "review" ||
    tab === "explorer" ||
    tab === "stats" ||
    tab === "output"
  ) {
    return TAB_CONFIGS[tab];
  }
  // File tabs
  if (tab.startsWith("file:")) {
    return FILE_TAB_CONFIG;
  }
  // All terminal tabs (including "terminal" placeholder)
  return TERMINAL_TAB_CONFIG;
}

/** Get display name for a tab type */
export function getTabName(tab: TabType): string {
  return getTabConfig(tab).name;
}

/** Get content container class name for a tab type */
export function getTabContentClassName(tab: TabType): string {
  return getTabConfig(tab).contentClassName;
}

/** Format duration for tab display (compact format) */
export function formatTabDuration(ms: number): string {
  if (ms < 60_000) return formatDuration(ms);
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
}
