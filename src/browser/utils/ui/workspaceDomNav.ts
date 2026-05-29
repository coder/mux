/**
 * DOM-based workspace navigation utilities.
 *
 * Reads the rendered sidebar to determine workspace ordering. This is the
 * canonical source of truth for "next/previous workspace" because it reflects
 * the exact visual order the user sees (respecting sort, sections, collapsed
 * projects, etc.).
 *
 * Shared by Ctrl+J/K navigation and the archive-then-navigate behaviour.
 */

/** Compound selector that targets only workspace *row* elements. */
const WORKSPACE_ROW_SELECTOR = "[data-workspace-id][data-workspace-path]";

/** Return all visible workspace IDs in DOM (sidebar) order. */
export function getVisibleWorkspaceIds(): string[] {
  const els = document.querySelectorAll(WORKSPACE_ROW_SELECTOR);
  return Array.from(els).map((el) => el.getAttribute("data-workspace-id")!);
}

/**
 * Given a workspace that is about to be removed (archived / deleted), return
 * the ID of the workspace the user should land on next.
 *
 * Prefers the item immediately *after* {@link currentWorkspaceId} (so the list
 * feels like it scrolled up to fill the gap), falling back to the item before
 * it.  When the current workspace isn't rendered at all (e.g. its project or
 * section is collapsed), returns the first visible workspace — matching how
 * Ctrl+J picks a target when the selection is off-screen.
 *
 * Returns `null` only when no other workspaces are visible in the sidebar.
 */
export function findAdjacentWorkspaceId(currentWorkspaceId: string): string | null {
  const ids = getVisibleWorkspaceIds();
  const idx = ids.indexOf(currentWorkspaceId);

  if (idx === -1) {
    // Current workspace not rendered (collapsed project/section) — pick the
    // first visible workspace that isn't the one being removed.
    return ids.find((id) => id !== currentWorkspaceId) ?? null;
  }

  // Prefer next (below), then previous (above).
  if (idx + 1 < ids.length) return ids[idx + 1];
  if (idx - 1 >= 0) return ids[idx - 1];
  return null;
}
