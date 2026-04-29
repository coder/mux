import type { KeyboardEvent, MouseEvent, UIEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
 * Owns one invariant: when bottom-lock is enabled, every observed transcript layout
 * change synchronously writes the viewport to its maximum scroll position. User
 * scrolls are the only way to release the lock; explicit actions such as opening a
 * chat, sending, or pressing "Jump to bottom" reacquire it.
 */
export function useAutoScroll() {
  const [autoScroll, setAutoScroll] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const innerObserverRef = useRef<ResizeObserver | null>(null);
  const scrollportObserverRef = useRef<ResizeObserver | null>(null);
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

    scrollContainer.scrollTop = getMaxScrollTop(scrollContainer);
  }, []);

  const stickToBottomIfAutoScroll = useCallback(() => {
    if (!autoScrollRef.current) return;

    stickToBottom();
  }, [stickToBottom]);

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
      if (event.target !== event.currentTarget || !TRANSCRIPT_SCROLL_KEYS.has(event.key)) return;

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

  const innerRef = useCallback(
    (element: HTMLDivElement | null) => {
      innerObserverRef.current?.disconnect();
      innerObserverRef.current = null;

      if (!element) return;

      const observer = new ResizeObserver(stickToBottomIfAutoScroll);
      observer.observe(element);
      innerObserverRef.current = observer;
    },
    [stickToBottomIfAutoScroll]
  );

  useLayoutEffect(() => {
    const scrollContainer = contentRef.current;
    if (!scrollContainer) return;

    const observer = new ResizeObserver(stickToBottomIfAutoScroll);
    observer.observe(scrollContainer);
    scrollportObserverRef.current = observer;

    return () => {
      observer.disconnect();
      if (scrollportObserverRef.current === observer) {
        scrollportObserverRef.current = null;
      }
    };
  }, [stickToBottomIfAutoScroll]);

  useEffect(() => {
    return () => {
      innerObserverRef.current?.disconnect();
      innerObserverRef.current = null;
      scrollportObserverRef.current?.disconnect();
      scrollportObserverRef.current = null;
    };
  }, []);

  return {
    contentRef,
    innerRef,
    autoScroll,
    disableAutoScroll,
    jumpToBottom,
    handleScroll,
    markUserScrollIntent,
    handleScrollContainerMouseDown,
    handleScrollContainerKeyDown,
  };
}
