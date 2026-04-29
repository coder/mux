import type { KeyboardEvent, MouseEvent, UIEvent } from "react";
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
    startBottomLockFrameLoop();
  }, [setAutoScrollEnabled, startBottomLockFrameLoop, stickToBottom]);

  const disableAutoScroll = useCallback(() => {
    userScrollIntentUntilRef.current = 0;
    programmaticDisableRef.current = true;
    setAutoScrollEnabled(false);
    stopBottomLockFrameLoop();
  }, [setAutoScrollEnabled, stopBottomLockFrameLoop]);

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

      // Keep momentum/scrollbar drags in the user-owned window without direction
      // bookkeeping. The geometry alone determines whether the tail is owned.
      userScrollIntentUntilRef.current = now + USER_SCROLL_INTENT_WINDOW_MS;
      const shouldEnableBottomLock = isWithinBottomThreshold(
        scrollContainer,
        USER_BOTTOM_RELOCK_THRESHOLD_PX
      );
      setAutoScrollEnabled(shouldEnableBottomLock);
      if (shouldEnableBottomLock) {
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
      startBottomLockFrameLoop();
    });
    observer.observe(scrollContainer);
    const content = scrollContainer.firstElementChild;
    if (content) {
      observer.observe(content);
    }

    return () => observer.disconnect();
  }, [autoScroll, startBottomLockFrameLoop]);

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
