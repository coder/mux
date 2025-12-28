export const RIGHT_SIDEBAR_TABS = ["costs", "review", "terminal", "stats"] as const;

export type TabType = (typeof RIGHT_SIDEBAR_TABS)[number];

export function isTabType(value: unknown): value is TabType {
  return typeof value === "string" && (RIGHT_SIDEBAR_TABS as readonly string[]).includes(value);
}
