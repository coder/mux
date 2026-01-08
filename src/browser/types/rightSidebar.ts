export const RIGHT_SIDEBAR_TABS = ["costs", "review", "terminal", "stats"] as const;

/** Base tab types that are always valid */
export type BaseTabType = (typeof RIGHT_SIDEBAR_TABS)[number];

/**
 * Extended tab type that supports multiple terminal instances.
 * Terminal tabs use the format "terminal" (default) or "terminal:<id>" for additional instances.
 */
export type TabType = BaseTabType | `terminal:${string}`;

/** Check if a value is a valid tab type (base tab or terminal instance) */
export function isTabType(value: unknown): value is TabType {
  if (typeof value !== "string") return false;
  if ((RIGHT_SIDEBAR_TABS as readonly string[]).includes(value)) return true;
  // Support terminal instances like "terminal:2", "terminal:abc"
  return value.startsWith("terminal:");
}

/** Check if a tab type represents a terminal (either base "terminal" or "terminal:<id>") */
export function isTerminalTab(tab: TabType): boolean {
  return tab === "terminal" || tab.startsWith("terminal:");
}

/** Get the terminal instance id from a terminal tab type, or undefined for base terminal */
export function getTerminalInstanceId(tab: TabType): string | undefined {
  if (tab === "terminal") return undefined;
  if (tab.startsWith("terminal:")) return tab.slice("terminal:".length);
  return undefined;
}

/** Create a terminal tab type for a given instance id */
export function makeTerminalTabType(instanceId?: string): TabType {
  return instanceId ? `terminal:${instanceId}` : "terminal";
}
