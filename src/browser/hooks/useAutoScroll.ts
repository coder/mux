import type { KeyboardEvent, MouseEvent, UIEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const BOTTOM_LOCK_EPSILON_PX = 1;
const USER_BOTTOM_RELOCK_THRESHOLD_PX = 8;
const USER_SCROLL_INTENT_WINDOW_MS = 750;
const TRANSCRIPT_SCROLL_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
  "Spacebar",
]);

function getMaxScrollTop(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function getDistanceFromBottom(element: HTMLElement): number {
  return getMaxScrollTop(element) - element.scrollTop;
}

function isWithinBottomThreshold(element: HTMLElement, thresholdPx: number): boolean {
  return getDistanceFromBottom(element) <= thresholdPx;
}

/**
 * Bottom-lock invariant: while `autoScroll` is true the transcript `scrollTop`
 * equals `scrollHeight - clientHeight`. The invariant is enforced on every
 * animation frame instead of relying on `ResizeObserver` delivery: real browsers
 * have several layout sources (sub-pixel CSS transitions, async font/image
 * settling, scroll-anchor races inside expanding tool panes) that don't always
 * fire RO in time for the upcoming paint, leaving the transcript a few pixels
 * above the true bottom. `requestAnimationFrame` runs once per rendering cycle
 * before paint, so any layout that could affect the next frame is corrected
 * before the user sees it. User input releases the lock; an explicit action
 * (open chat, send, jump-to-bottom) or geometric return-to-bottom reacquires it.
 */
export function useAutoScroll() {
  const [autoScroll, setAutoScroll] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const programmaticDisableRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);

  const setAutoScrollEnabled = useCallback((enabled: boolean) => {
    autoScrollRef.current = enabled;
    setAutoScroll(enabled);
  }, []);

  const stickToBottom = useCallback(() => {
    const scrollContainer = contentRef.current;
    if (!scrollContainer) return;

    const max = getMaxScrollTop(scrollContainer);
    if (scrollContainer.scrollTop !== max) {
      scrollContainer.scrollTop = max;
    }
  }, []);

  const jumpToBottom = useCallback(() => {
    // Opening/sending is an explicit transfer of scroll ownership back to the
    // transcript tail. Clear stale wheel/touch/key intent before the browser emits
    // any scroll event caused by our own write.
    userScrollIntentUntilRef.current = 0;
    programmaticDisableRef.current = false;
    setAutoScrollEnabled(true);
    stickToBottom();
  }, [setAutoScrollEnabled, stickToBottom]);

  const disableAutoScroll = useCallback(() => {
    userScrollIntentUntilRef.current = 0;
    programmaticDisableRef.current = true;
    setAutoScrollEnabled(false);
  }, [setAutoScrollEnabled]);

  const markUserScrollIntent = useCallback(() => {
    programmaticDisableRef.current = false;
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_WINDOW_MS;
  }, []);

  const handleScrollContainerMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      // Expanding transcript chrome (for example the last bash tool) starts with a
      // content mousedown and then changes layout. That click is not scroll intent:
      // only a mousedown on the scrollport itself can represent a scrollbar drag.
      if (event.target !== event.currentTarget) return;

      markUserScrollIntent();
    },
    [markUserScrollIntent]
  );

  const handleScrollContainerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // Scroll keys (PageUp/PageDown/Home/End/Arrows/Space) cause the scrollport
      // to scroll regardless of which descendant currently has focus, so they
      // are always user scroll intent. Filtering by `event.target === event
      // .currentTarget` would incorrectly ignore key presses while focus is on
      // a transcript-internal element such as a tool-row button or a link.
      if (!TRANSCRIPT_SCROLL_KEYS.has(event.key)) return;

      markUserScrollIntent();
    },
    [markUserScrollIntent]
  );

  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const scrollContainer = e.currentTarget;
      const now = Date.now();
      if (now > userScrollIntentUntilRef.current) {
        if (
          autoScrollRef.current &&
          !isWithinBottomThreshold(scrollContainer, BOTTOM_LOCK_EPSILON_PX)
        ) {
          stickToBottom();
          return;
        }

        if (
          !autoScrollRef.current &&
          !programmaticDisableRef.current &&
          isWithinBottomThreshold(scrollContainer, USER_BOTTOM_RELOCK_THRESHOLD_PX)
        ) {
          setAutoScrollEnabled(true);
        }
        return;
      }

      // Keep momentum/scrollbar drags in the user-owned window without direction
      // bookkeeping. The geometry alone determines whether the tail is owned.
      userScrollIntentUntilRef.current = now + USER_SCROLL_INTENT_WINDOW_MS;
      setAutoScrollEnabled(
        isWithinBottomThreshold(scrollContainer, USER_BOTTOM_RELOCK_THRESHOLD_PX)
      );
    },
    [setAutoScrollEnabled, stickToBottom]
  );

  // Frame-aligned bottom-lock enforcer.
  //
  // The loop only runs while the lock is held, so manual reading sessions pay
  // no per-frame cost. While locked, every animation frame writes
  // `scrollTop = scrollHeight - clientHeight` (cheap no-op when already there).
  // This makes the bottom lock independent of any single layout signal source —
  // bash/tool expansion, async syntax highlighting, mermaid render, font swap,
  // image load, scroll-anchor rebalancing all converge before the next paint.
  //
  // Resolve rAF/cAF from `window` rather than bare globals so happy-dom-driven
  // tests can install a deterministic scheduler on a per-test window without
  // polluting `globalThis` (which would leak the mock into unrelated tests).
  useEffect(() => {
    if (!autoScroll) return;
    const win = typeof window !== "undefined" ? window : undefined;
    const raf = win?.requestAnimationFrame?.bind(win);
    const caf = win?.cancelAnimationFrame?.bind(win);
    if (!raf || !caf) return;

    let rafId = raf(function tick() {
      stickToBottom();
      rafId = raf(tick);
    });

    return () => caf(rafId);
  }, [autoScroll, stickToBottom]);

  return {
    contentRef,
    autoScroll,
    disableAutoScroll,
    jumpToBottom,
    handleScroll,
    markUserScrollIntent,
    handleScrollContainerMouseDown,
    handleScrollContainerKeyDown,
  };
}
