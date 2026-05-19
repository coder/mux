import type { KeyboardEvent, MouseEvent, UIEvent, WheelEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const BOTTOM_LOCK_EPSILON_PX = 1;
const USER_BOTTOM_RELOCK_THRESHOLD_PX = 8;
const USER_SCROLL_INTENT_WINDOW_MS = 750;
const BOTTOM_LOCK_SETTLE_FRAME_LIMIT = 60;
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

const TRANSCRIPT_SCROLL_INTENT_EXEMPT_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[contenteditable="true"]',
  '[data-scroll-intent="ignore"]',
].join(",");

function getMaxScrollTop(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function isWithinBottomThreshold(element: HTMLElement, thresholdPx: number): boolean {
  return getMaxScrollTop(element) - element.scrollTop <= thresholdPx;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;

  return (
    target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !== null
  );
}

function isMouseDownExemptFromScrollIntent(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  if (!(target instanceof Element)) return false;

  const exemptElement = target.closest(TRANSCRIPT_SCROLL_INTENT_EXEMPT_SELECTOR);
  return exemptElement !== null && currentTarget.contains(exemptElement);
}

/**
 * Bottom-lock invariant: while `autoScroll` is true the transcript `scrollTop`
 * equals `scrollHeight - clientHeight`. Layout signals such as ResizeObserver,
 * open-chat, send, and geometric relock arm a short requestAnimationFrame settle
 * window instead of polling forever. The rAF tick lands just before paint, so
 * sub-pixel CSS transitions, async font/image settling, and scroll-anchor races
 * inside expanding tool panes converge without adding continuous idle work.
 * User input releases the lock; an explicit action (open chat, send,
 * jump-to-bottom) or geometric return-to-bottom reacquires it.
 */
export function useAutoScroll() {
  const [autoScroll, setAutoScroll] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const programmaticDisableRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);
  // Tracks the scrollTop observed during the previous handleScroll call so the
  // user-intent branch can tell "user moving away from bottom" from "user
  // moving toward bottom" without consulting wheel/touch deltas. Direction is
  // what lets a slow wheel-up gesture release the lock on the first tick
  // without the relock heuristic snapping it back to the bottom mid-gesture.
  const lastScrollTopRef = useRef(0);

  const setAutoScrollEnabled = useCallback((enabled: boolean) => {
    autoScrollRef.current = enabled;
    setAutoScroll(enabled);
  }, []);

  // Seed the baseline read by handleScroll's released-branch direction check
  // (`currentScrollTop > previousScrollTop`). Call this from any code path that
  // flips autoScrollRef / programmaticDisableRef without a guaranteed follow-up
  // scroll event — e.g. jumpToBottom skips the write when scrollTop is already
  // max, and disableAutoScroll never fires a scroll event itself. Without a
  // fresh baseline, the next user-driven scroll event could compare against a
  // stale value (carried across workspace switches or the prior session) and
  // misread a small wheel-up notch as "moving toward bottom", spuriously
  // relocking the lock that was just released.
  const seedScrollDirectionBaseline = useCallback(() => {
    lastScrollTopRef.current = contentRef.current?.scrollTop ?? 0;
  }, []);

  const stickToBottom = useCallback(() => {
    const scrollContainer = contentRef.current;
    if (!scrollContainer) return;

    const max = getMaxScrollTop(scrollContainer);
    if (scrollContainer.scrollTop !== max) {
      scrollContainer.scrollTop = max;
    }
  }, []);

  const frameLoopRef = useRef<{ id: number | null; framesRemaining: number }>({
    id: null,
    framesRemaining: 0,
  });

  const stopBottomLockFrameLoop = useCallback(() => {
    const frameId = frameLoopRef.current.id;
    if (frameId !== null && typeof window !== "undefined") {
      const cancelFrame = window.cancelAnimationFrame?.bind(window);
      cancelFrame?.(frameId);
    }
    frameLoopRef.current.id = null;
    frameLoopRef.current.framesRemaining = 0;
  }, []);

  const startBottomLockFrameLoop = useCallback(() => {
    if (!autoScrollRef.current) return;
    const win = typeof window !== "undefined" ? window : undefined;
    const raf = win?.requestAnimationFrame?.bind(win);
    if (!raf) return;

    frameLoopRef.current.framesRemaining = BOTTOM_LOCK_SETTLE_FRAME_LIMIT;
    if (frameLoopRef.current.id !== null) return;

    const tick = () => {
      frameLoopRef.current.id = null;
      if (!autoScrollRef.current || frameLoopRef.current.framesRemaining <= 0) {
        frameLoopRef.current.framesRemaining = 0;
        return;
      }

      stickToBottom();
      frameLoopRef.current.framesRemaining -= 1;
      if (frameLoopRef.current.framesRemaining > 0) {
        frameLoopRef.current.id = raf(tick);
      }
    };

    frameLoopRef.current.id = raf(tick);
  }, [stickToBottom]);

  const jumpToBottom = useCallback(() => {
    // Opening/sending is an explicit transfer of scroll ownership back to the
    // transcript tail. Clear stale wheel/touch/key intent before the browser emits
    // any scroll event caused by our own write.
    userScrollIntentUntilRef.current = 0;
    programmaticDisableRef.current = false;
    setAutoScrollEnabled(true);
    stickToBottom();
    // stickToBottom skips the write when scrollTop is already max, so we may
    // not get a follow-up scroll event to refresh lastScrollTopRef.
    seedScrollDirectionBaseline();
    startBottomLockFrameLoop();
  }, [seedScrollDirectionBaseline, setAutoScrollEnabled, startBottomLockFrameLoop, stickToBottom]);

  const disableAutoScroll = useCallback(() => {
    userScrollIntentUntilRef.current = 0;
    programmaticDisableRef.current = true;
    setAutoScrollEnabled(false);
    // disableAutoScroll never fires a scroll event itself, so seed the
    // baseline now to keep the next user-driven scroll event's direction
    // check honest.
    seedScrollDirectionBaseline();
    stopBottomLockFrameLoop();
  }, [seedScrollDirectionBaseline, setAutoScrollEnabled, stopBottomLockFrameLoop]);

  const markUserScrollIntent = useCallback(() => {
    programmaticDisableRef.current = false;
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_WINDOW_MS;
  }, []);

  const handleScrollContainerWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      // Filter delta-0 wheel events before opening a scroll-intent window.
      // Modifier-key wheel (Cmd-wheel browser zoom on macOS, Shift-wheel for
      // horizontal-only on some setups), pinch gestures, and Bluetooth-mouse
      // jitter all dispatch wheel events with deltaY === 0 (and often
      // deltaX === 0). Without this filter every such phantom wheel would
      // clear programmaticDisableRef and refresh the 750 ms intent window,
      // weakening every downstream gate that relies on those refs.
      if (event.deltaY === 0 && event.deltaX === 0) return;
      markUserScrollIntent();
    },
    [markUserScrollIntent]
  );

  const contentMouseDownCandidateRef = useRef(false);

  const handleScrollContainerMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      contentMouseDownCandidateRef.current = false;

      // Scrollbar drags target the scrollport itself and are immediately scroll intent.
      if (event.target === event.currentTarget) {
        markUserScrollIntent();
        return;
      }

      // Interactive transcript chrome (tool headers/buttons/links) is exempt so
      // expanding the last bash/tool row keeps bottom ownership.
      if (isMouseDownExemptFromScrollIntent(event.target, event.currentTarget)) {
        return;
      }

      // A simple content click is not scroll intent. It only becomes user-owned
      // once the pointer moves with the mouse button down, which covers
      // drag-to-select autoscroll without letting expand/collapse clicks release
      // the bottom lock.
      contentMouseDownCandidateRef.current = true;
    },
    [markUserScrollIntent]
  );

  const handleScrollContainerMouseMove = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!contentMouseDownCandidateRef.current) return;

      if (event.buttons !== 1) {
        contentMouseDownCandidateRef.current = false;
        return;
      }

      contentMouseDownCandidateRef.current = false;
      markUserScrollIntent();
    },
    [markUserScrollIntent]
  );

  const handleScrollContainerMouseUp = useCallback(() => {
    contentMouseDownCandidateRef.current = false;
  }, []);

  const handleScrollContainerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // Scroll keys (PageUp/PageDown/Home/End/Arrows/Space) cause the scrollport
      // to scroll even when focus is on non-editable descendants such as tool-row
      // buttons or links. Editable controls keep those keys local for caret/text
      // navigation, so they must not open a transcript scroll-intent window.
      if (!TRANSCRIPT_SCROLL_KEYS.has(event.key) || isEditableKeyboardTarget(event.target)) return;

      markUserScrollIntent();
    },
    [markUserScrollIntent]
  );

  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const scrollContainer = e.currentTarget;
      const now = Date.now();
      const previousScrollTop = lastScrollTopRef.current;
      const currentScrollTop = scrollContainer.scrollTop;
      lastScrollTopRef.current = currentScrollTop;
      if (now > userScrollIntentUntilRef.current) {
        if (
          autoScrollRef.current &&
          !isWithinBottomThreshold(scrollContainer, BOTTOM_LOCK_EPSILON_PX)
        ) {
          stickToBottom();
          startBottomLockFrameLoop();
          return;
        }

        if (
          !autoScrollRef.current &&
          !programmaticDisableRef.current &&
          isWithinBottomThreshold(scrollContainer, USER_BOTTOM_RELOCK_THRESHOLD_PX)
        ) {
          setAutoScrollEnabled(true);
          startBottomLockFrameLoop();
        }
        return;
      }

      // User-intent window is open (wheel/touch/key/scrollbar within the last
      // USER_SCROLL_INTENT_WINDOW_MS). Refresh the window first so momentum
      // and scrollbar drags stay user-owned across multiple scroll events.
      userScrollIntentUntilRef.current = now + USER_SCROLL_INTENT_WINDOW_MS;

      if (autoScrollRef.current) {
        // Currently locked. Release on the first pixel of drift away from the
        // bottom. Using USER_BOTTOM_RELOCK_THRESHOLD_PX here would let small
        // wheel deltas (~3-7 px, typical for a single mousewheel notch) keep
        // the lock engaged, and the next rAF settle tick would write
        // `scrollTop = max` again — perceived as scroll-up resistance / jitter
        // at the start of the gesture until the user accumulates enough delta
        // to break past the relock threshold.
        if (!isWithinBottomThreshold(scrollContainer, BOTTOM_LOCK_EPSILON_PX)) {
          setAutoScrollEnabled(false);
        }
        return;
      }

      // Currently released. Re-engage the lock only when the user is scrolling
      // toward the bottom and lands within the relock window. The direction
      // check prevents a relock mid-gesture when the user is still scrolling
      // up but happens to be ≤ USER_BOTTOM_RELOCK_THRESHOLD_PX from the bottom
      // (e.g., the second small wheel tick after the first one already
      // released the lock).
      const userScrollingTowardBottom = currentScrollTop > previousScrollTop;
      if (
        userScrollingTowardBottom &&
        isWithinBottomThreshold(scrollContainer, USER_BOTTOM_RELOCK_THRESHOLD_PX)
      ) {
        setAutoScrollEnabled(true);
        startBottomLockFrameLoop();
      }
    },
    [setAutoScrollEnabled, startBottomLockFrameLoop, stickToBottom]
  );

  // Frame-aligned bottom-lock enforcer.
  //
  // The rAF work is bounded: open-chat/send/relock/resize signals arm a short
  // settle window, and the loop stops once that budget is exhausted or the user
  // releases the lock. That keeps the paint-aligned correction without continuous
  // idle polling in long-lived chats.
  useEffect(() => {
    if (autoScroll) {
      startBottomLockFrameLoop();
      return stopBottomLockFrameLoop;
    }

    stopBottomLockFrameLoop();
    return undefined;
  }, [autoScroll, startBottomLockFrameLoop, stopBottomLockFrameLoop]);

  useEffect(() => {
    if (!autoScroll) return;
    const scrollContainer = contentRef.current;
    const ResizeObserverCtor = typeof window !== "undefined" ? window.ResizeObserver : undefined;
    if (!scrollContainer || !ResizeObserverCtor) return;

    const observer = new ResizeObserverCtor(() => {
      if (!autoScrollRef.current) return;
      stickToBottom();
      startBottomLockFrameLoop();
    });
    observer.observe(scrollContainer);
    const content = scrollContainer.firstElementChild;
    if (content) {
      observer.observe(content);
    }

    return () => observer.disconnect();
  }, [autoScroll, startBottomLockFrameLoop, stickToBottom]);

  return {
    contentRef,
    autoScroll,
    disableAutoScroll,
    jumpToBottom,
    handleScroll,
    markUserScrollIntent,
    handleScrollContainerWheel,
    handleScrollContainerMouseDown,
    handleScrollContainerMouseMove,
    handleScrollContainerMouseUp,
    handleScrollContainerKeyDown,
  };
}
