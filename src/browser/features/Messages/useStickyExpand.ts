import { useState } from "react";

import { getAutoExpandPrefsKey } from "@/common/constants/storage";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";

import { useOptionalMessageListContext } from "./MessageListContext";

/** Transcript block types that share a per-workspace sticky auto-expand preference. */
export type ExpandableBlockKind = "thinking" | "tools";

/**
 * Per-workspace, per-type record of the user's last expand/collapse intent.
 * Persisted under getAutoExpandPrefsKey(workspaceId). A missing entry falls back
 * to each block's own default.
 */
export type AutoExpandPrefs = Partial<Record<ExpandableBlockKind, boolean>>;

export interface UseStickyExpandOptions {
  /**
   * Force the block expanded regardless of the stored preference (e.g. a live,
   * blocking AskUserQuestion prompt that must not be hidden). Only overrides the
   * initial seed — the user can still collapse it.
   */
  forceExpanded?: boolean;
}

interface StickyExpandState {
  expanded: boolean;
  setExpanded: (next: boolean) => void;
  toggleExpanded: () => void;
}

/**
 * Sticky expand/collapse state for transcript blocks (thinking + tools).
 *
 * UX contract — legible stickiness with no layout flashes:
 *  - Initial state is seeded ONCE at mount from the workspace's stored preference
 *    for `kind` (falling back to `fallbackExpanded`). We read with
 *    readPersistedState (NOT usePersistedState) so the block does not subscribe;
 *    a later preference change therefore cannot retroactively expand/collapse an
 *    already-mounted block — only blocks that mount afterwards inherit it.
 *  - A user toggle writes the preference so FUTURE blocks of this kind inherit the
 *    choice. This is the only write path.
 *
 * workspaceId comes from MessageListContext (which wraps the whole transcript), so
 * no prop-drilling is needed; outside that context (e.g. isolated tests) the hook
 * degrades to local-only state with no persistence.
 */
export function useStickyExpand(
  kind: ExpandableBlockKind,
  fallbackExpanded: boolean,
  options?: UseStickyExpandOptions
): StickyExpandState {
  const forceExpanded = options?.forceExpanded ?? false;
  const workspaceId = useOptionalMessageListContext()?.workspaceId;

  const [expanded, setExpandedState] = useState<boolean>(() => {
    if (forceExpanded) {
      return true;
    }
    if (workspaceId == null) {
      return fallbackExpanded;
    }
    const prefs = readPersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey(workspaceId), {});
    return prefs[kind] ?? fallbackExpanded;
  });

  const setExpanded = (next: boolean): void => {
    setExpandedState(next);
    // Record the user's intent so future blocks of this kind inherit it. Present
    // blocks read the preference once (above) and never subscribe, so this write
    // cannot mutate any already-mounted block.
    if (workspaceId != null) {
      updatePersistedState<AutoExpandPrefs>(
        getAutoExpandPrefsKey(workspaceId),
        (prev) => ({ ...prev, [kind]: next }),
        {}
      );
    }
  };

  return {
    expanded,
    setExpanded,
    toggleExpanded: () => setExpanded(!expanded),
  };
}
