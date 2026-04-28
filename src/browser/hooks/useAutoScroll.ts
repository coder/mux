import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const BOTTOM_LOCK_EPSILON_PX = 1;
const USER_BOTTOM_RELOCK_THRESHOLD_PX = 8;
const USER_SCROLL_INTENT_WINDOW_MS = 750;

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
    setAutoScrollEnabled(true);
    stickToBottom();
  }, [setAutoScrollEnabled, stickToBottom]);

  const disableAutoScroll = useCallback(() => {
    userScrollIntentUntilRef.current = 0;
    setAutoScrollEnabled(false);
  }, [setAutoScrollEnabled]);

  const markUserInteraction = useCallback(() => {
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_WINDOW_MS;
  }, []);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const scrollContainer = e.currentTarget;
      const now = Date.now();
      if (now > userScrollIntentUntilRef.current) {
        if (
          autoScrollRef.current &&
          !isWithinBottomThreshold(scrollContainer, BOTTOM_LOCK_EPSILON_PX)
        ) {
          stickToBottom();
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
    markUserInteraction,
  };
}
