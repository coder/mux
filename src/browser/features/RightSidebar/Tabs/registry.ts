/**
 * Backwards-compat shim — the real registry now lives in
 * `tabRegistry.tsx` (single source of truth for adding/removing tabs).
 *
 * This file remains so legacy callers can import `getTabContentClassName`,
 * `getTabName`, etc. without churn, but new code should depend on
 * `tabRegistry` directly.
 */

import type { TabType } from "@/browser/types/rightSidebar";
import {
  TAB_REGISTRY,
  isBaseTabId,
  type ReviewStats as RegistryReviewStats,
  type TabPanelContext,
  type TabLabelContext,
} from "./tabRegistry";

/** Re-exported review stats type (used by RightSidebar wrapper props). */
export type ReviewStats = RegistryReviewStats;
export type { TabPanelContext, TabLabelContext };

/** Configuration for a terminal tab (still special-cased outside the registry). */
const TERMINAL_TAB_CONTENT_CLASS_NAME = "overflow-hidden p-0";
const TERMINAL_TAB_NAME = "Terminal";

/** Display name for a tab id (incl. terminal). */
export function getTabName(tab: TabType): string {
  if (isBaseTabId(tab)) return TAB_REGISTRY[tab].name;
  return TERMINAL_TAB_NAME;
}

/** Content container CSS classes for a tab id (incl. terminal). */
export function getTabContentClassName(tab: TabType): string {
  if (isBaseTabId(tab)) return TAB_REGISTRY[tab].contentClassName;
  return TERMINAL_TAB_CONTENT_CLASS_NAME;
}
