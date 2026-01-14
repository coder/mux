export const RIGHT_SIDEBAR_TABS = ["costs", "review", "terminal", "explorer", "stats"] as const;

/** Base tab types that are always valid */
export type BaseTabType = (typeof RIGHT_SIDEBAR_TABS)[number];

/**
 * Extended tab type that supports multiple terminal instances.
 * Terminal tabs use the format "terminal" (placeholder for new) or "terminal:<sessionId>" for real sessions.
 * The sessionId comes from the backend when the terminal is created.
 */
export type TabType = BaseTabType | `terminal:${string}`;

/** Check if a value is a valid tab type (base tab or terminal instance) */
export function isTabType(value: unknown): value is TabType {
  if (typeof value !== "string") return false;
  if ((RIGHT_SIDEBAR_TABS as readonly string[]).includes(value)) return true;
  // Support terminal instances like "terminal:ws-123-1704567890"
  return value.startsWith("terminal:");
}

/** Check if a tab type represents a terminal (either base "terminal" or "terminal:<sessionId>") */
export function isTerminalTab(tab: TabType): boolean {
  return tab === "terminal" || tab.startsWith("terminal:");
}

/**
 * Get the backend session ID from a terminal tab type.
 * Returns undefined for the placeholder "terminal" tab (new terminal being created).
 */
export function getTerminalSessionId(tab: TabType): string | undefined {
  if (tab === "terminal") return undefined;
  if (tab.startsWith("terminal:")) return tab.slice("terminal:".length);
  return undefined;
}

/** Create a terminal tab type for a given session ID */
export function makeTerminalTabType(sessionId?: string): TabType {
  return sessionId ? `terminal:${sessionId}` : "terminal";
}
