import { useCallback, useRef, useState } from "react";

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
   * Live "must open" signal layered above the stored preference/fallback (e.g. a
   * blocking AskUserQuestion prompt while executing, or a tool whose error/failure
   * only becomes known after mount — task errors, failed `task_await` sub-tasks).
   *
   * It is latched monotonically: the row opens on the rising edge but the signal
   * going false again never collapses a present block (no height tear). A user
   * toggle still wins over it, so the row remains collapsible.
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
 * UX contract — legible stickiness with no layout flashes. Effective state is
 * `userChoice ?? (forceLatched || (storedPref ?? fallbackExpanded))`:
 *  - The stored preference and `fallbackExpanded` are snapshotted ONCE at mount
 *    (via readPersistedState, NOT usePersistedState — no subscription), so a later
 *    preference change from another block can never retroactively expand/collapse
 *    this already-mounted block. Only blocks that mount afterwards inherit it.
 *  - `forceExpanded` is a live "must open" signal, latched monotonically: it opens
 *    the row on its rising edge (e.g. a task error arriving after mount) but never
 *    forces a collapse, so a present block is never torn closed.
 *  - A user toggle wins over everything and is the only thing that writes the
 *    preference, so FUTURE blocks of this kind inherit the choice.
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

  // Snapshot the stored preference + fallback ONCE at mount. Freezing them is what
  // guarantees the present-block invariant: neither another block's preference write
  // nor a convenience fallback that later flips (e.g. FileEdit's `!isFailed`) can
  // mutate this row's baseline.
  const [seed] = useState<{ pref: boolean | undefined; fallback: boolean }>(() => ({
    pref:
      workspaceId == null
        ? undefined
        : readPersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey(workspaceId), {})[kind],
    fallback: fallbackExpanded,
  }));

  // The user's explicit toggle wins over everything and is the only thing we persist.
  const [userChoice, setUserChoice] = useState<boolean | null>(null);

  // Latch forceExpanded monotonically so a signal that turns on after mount (a task
  // error / failed sub-task) still opens the row, while a signal turning back off
  // never collapses a present block.
  const [forceLatched, setForceLatched] = useState<boolean>(forceExpanded);
  if (forceExpanded && !forceLatched) {
    setForceLatched(true);
  }

  const expanded = userChoice ?? (forceLatched || (seed.pref ?? seed.fallback));

  // Keep the latest expanded value available to setExpanded without making the
  // callback identity depend on it.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // setExpanded/toggleExpanded MUST keep a stable identity across renders. Consumers
  // pass setExpanded into effect dependency arrays — e.g. WorkflowRunToolCall lists it
  // in a useLayoutEffect and a useEffect — and the previous useToolExpansion returned
  // React's stable useState setter, so those effects only re-ran on real changes. The
  // bun test runtime does NOT apply the React Compiler, so without an explicit stable
  // identity these closures change every render and re-fire those consumer effects on
  // every commit; the synchronous useLayoutEffect variant then spins act() forever
  // (observed as a hung unit test). This is a correctness requirement, not perf memo.
  const setExpanded = useCallback(
    (next: boolean): void => {
      setUserChoice(next);
      if (workspaceId != null) {
        updatePersistedState<AutoExpandPrefs>(
          getAutoExpandPrefsKey(workspaceId),
          (prev) => ({ ...prev, [kind]: next }),
          {}
        );
      }
    },
    [workspaceId, kind]
  );

  // expandedRef keeps toggleExpanded reading the latest value without taking a
  // dependency on `expanded`, so its identity stays stable too.
  const toggleExpanded = useCallback(() => setExpanded(!expandedRef.current), [setExpanded]);

  return {
    expanded,
    setExpanded,
    toggleExpanded,
  };
}
