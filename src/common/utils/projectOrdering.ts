// Utilities for ordering and reordering projects in the sidebar
// Developer notes:
// - Order is a UI concern only. Persist it with usePersistedState in localStorage.
// - We represent order as an array of project paths (string[]).
// - This file is intentionally framework-agnostic and pure for easy testing.

import type { ProjectConfig } from "@/node/config";

/**
 * Sort projects by the provided order array. Unknown projects go to the end preserving natural order.
 */
export function sortProjectsByOrder(
  projects: Map<string, ProjectConfig>,
  order: string[]
): Array<[string, ProjectConfig]> {
  const entries = Array.from(projects.entries());

  if (order.length === 0) {
    // Sort lexically for stable, deterministic order
    return entries.sort(([a], [b]) => a.localeCompare(b));
  }

  const pos = new Map(order.map((p, i) => [p, i]));

  return entries.sort(([a], [b]) => {
    const ia = pos.get(a);
    const ib = pos.get(b);
    const da = ia ?? Number.MAX_SAFE_INTEGER;
    const db = ib ?? Number.MAX_SAFE_INTEGER;
    // Stable sort for equal positions: fall back to lexical path
    if (da === db) return a.localeCompare(b);
    return da - db;
  });
}

/**
 * Recompute the order array after dragging one project onto another.
 * Drop semantics: place dragged item at the target's index.
 */
export function reorderProjects(
  currentOrder: string[],
  allProjects: Map<string, ProjectConfig>,
  draggedPath: string,
  targetPath: string
): string[] {
  const sorted = sortProjectsByOrder(allProjects, currentOrder).map(([p]) => p);

  const from = sorted.indexOf(draggedPath);
  const to = sorted.indexOf(targetPath);

  if (from === -1 || to === -1 || from === to) return sorted;

  const next = [...sorted];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Normalize an order array against the current set of projects.
 * - Removes paths that no longer exist
 * - Prepends new paths to the front (preserving their natural order)
 *
 * UX rationale: when a user adds a project, they almost always want to use it next. Putting newly
 * added projects at the top makes that action feel "recent" even if the user already has a custom
 * project ordering.
 */
export function normalizeOrder(order: string[], projects: Map<string, ProjectConfig>): string[] {
  const present = new Set(projects.keys());
  const filtered = order.filter((p) => present.has(p));
  // Sort missing projects lexically for deterministic order (avoids flaky UI in Storybook)
  const missing = Array.from(projects.keys())
    .filter((p) => !filtered.includes(p))
    .sort((a, b) => a.localeCompare(b));
  return [...missing, ...filtered];
}

/**
 * Shallow equality for string arrays.
 */
export function equalOrders(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
