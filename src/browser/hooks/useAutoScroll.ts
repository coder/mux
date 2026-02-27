import { useRef, useState, useCallback } from "react";

/**
 * Hook to manage auto-scrolling behavior for a scrollable container.
 *
 * Scroll container structure expected:
 *   <div ref={contentRef}>           ← scroll container (overflow-y: auto)
 *     <div ref={innerRef}>           ← inner content wrapper (observed for size changes)
 *       {children}
 *     </div>
 *   </div>
 *
 * Auto-scroll is enabled when:
 * - User sends a message
 * - User scrolls to bottom while content is updating
 *
 * Auto-scroll is disabled when:
 * - User scrolls up
 */
export function useAutoScroll() {
  const [autoScroll, setAutoScroll] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const lastScrollTopRef = useRef<number>(0);
  const lastUserInteractionRef = useRef<number>(0);
  // Ref to avoid stale closures in async callbacks - always holds current autoScroll value
  const autoScrollRef = useRef<boolean>(true);
  // Track the ResizeObserver so we can disconnect it when the element unmounts
  const observerRef = useRef<ResizeObserver | null>(null);
  // Track pending RAF to coalesce rapid resize events
  const rafIdRef = useRef<number | null>(null);
  // Debounce timer for "scroll settled" detection — fires after scrolling stops
  // to catch cases where iOS momentum/inertial scrolling reaches the bottom but
  // the user-interaction window (100ms after last touchmove) has already expired.
  const scrollSettledTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set by disableAutoScroll() to prevent the scroll-settled debounce from
  // re-arming after programmatic scrolls (scrollIntoView, etc.). Cleared when
  // the user touches the scroll container (markUserInteraction).
  const programmaticDisableRef = useRef(false);

  // Sync ref with state to ensure callbacks always have latest value
  autoScrollRef.current = autoScroll;

  // Callback ref for the inner content wrapper - sets up ResizeObserver when element mounts.
  // ResizeObserver fires when the content size changes (Shiki highlighting, Mermaid, images, etc.),
  // allowing us to scroll to bottom even when async content renders after the initial mount.
  const innerRef = useCallback((element: HTMLDivElement | null) => {
    // Cleanup previous observer and pending RAF
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (!element) return;

    const observer = new ResizeObserver(() => {
      // Skip if auto-scroll is disabled (user scrolled up)
      if (!autoScrollRef.current || !contentRef.current) return;

      // Coalesce all resize events in a frame into one scroll operation.
      // Without this, rapid resize events (Shiki highlighting, etc.) cause
      // multiple scrolls per frame with slightly different scrollHeight values.
      rafIdRef.current ??= requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (autoScrollRef.current && contentRef.current) {
          contentRef.current.scrollTop = contentRef.current.scrollHeight;
        }
      });
    });

    observer.observe(element);
    observerRef.current = observer;
  }, []);

  const performAutoScroll = useCallback(() => {
    if (!contentRef.current) return;

    // Double RAF: First frame for DOM updates (e.g., DiffRenderer async highlighting),
    // second frame to scroll after layout is complete
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Check ref.current not state - avoids race condition where queued frames
        // execute after user scrolls up but still see old autoScroll=true
        if (contentRef.current && autoScrollRef.current) {
          contentRef.current.scrollTop = contentRef.current.scrollHeight;
        }
      });
    });
  }, []); // No deps - ref ensures we always check current value

  const jumpToBottom = useCallback(() => {
    // Enable auto-scroll first so ResizeObserver will handle subsequent changes
    setAutoScroll(true);
    autoScrollRef.current = true;

    // Immediate scroll for content that's already rendered
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, []);

  // Programmatic disable — clears any pending scroll-settled recovery timer so
  // intentional disables (navigate-to-message, edit-message) aren't undone by the
  // debounced re-enable. Use this instead of setAutoScroll(false) for explicit
  // code-driven disables; the scroll handler's own disable (user scrolls up)
  // deliberately does NOT clear the timer so the debounce can recover when the
  // user scrolls back to the bottom.
  const disableAutoScroll = useCallback(() => {
    setAutoScroll(false);
    autoScrollRef.current = false;
    programmaticDisableRef.current = true;
    if (scrollSettledTimerRef.current) {
      clearTimeout(scrollSettledTimerRef.current);
      scrollSettledTimerRef.current = null;
    }
  }, []);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const element = e.currentTarget;
    const currentScrollTop = element.scrollTop;
    const threshold = 100;
    const isAtBottom = element.scrollHeight - currentScrollTop - element.clientHeight < threshold;

    // Safety net: when auto-scroll is disabled and *downward* scrolling stops at
    // the bottom, re-enable it. Only armed on downward movement so that a small
    // upward scroll near the bottom (< threshold) doesn't get its disable undone.
    // The 150ms debounce is long enough that upward momentum from the bottom will
    // keep resetting the timer before it fires.
    const isMovingDown = currentScrollTop > lastScrollTopRef.current;
    if (scrollSettledTimerRef.current) {
      clearTimeout(scrollSettledTimerRef.current);
      scrollSettledTimerRef.current = null;
    }
    if (!autoScrollRef.current && isMovingDown && !programmaticDisableRef.current) {
      scrollSettledTimerRef.current = setTimeout(() => {
        scrollSettledTimerRef.current = null;
        if (contentRef.current && !autoScrollRef.current) {
          const el = contentRef.current;
          const settledAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
          if (settledAtBottom) {
            setAutoScroll(true);
            autoScrollRef.current = true;
          }
        }
      }, 150);
    }

    // Only process user-initiated scrolls (within 100ms of interaction)
    const isUserScroll = Date.now() - lastUserInteractionRef.current < 100;

    if (!isUserScroll) {
      lastScrollTopRef.current = currentScrollTop;
      return; // Ignore programmatic scrolls
    }

    // Detect scroll direction
    const isScrollingUp = currentScrollTop < lastScrollTopRef.current;
    const isScrollingDown = currentScrollTop > lastScrollTopRef.current;

    if (isScrollingUp) {
      // Always disable auto-scroll when scrolling up
      setAutoScroll(false);
      autoScrollRef.current = false;
    } else if (isScrollingDown && isAtBottom) {
      // Only enable auto-scroll if scrolling down AND reached the bottom
      setAutoScroll(true);
      autoScrollRef.current = true;
    }
    // If scrolling down but not at bottom, auto-scroll remains disabled

    // Update last scroll position
    lastScrollTopRef.current = currentScrollTop;
  }, []);

  const markUserInteraction = useCallback(() => {
    lastUserInteractionRef.current = Date.now();
    // Clear programmatic disable flag — the user is now interacting with the
    // scroll container, so the debounced scroll-settled recovery can re-arm.
    programmaticDisableRef.current = false;
  }, []);

  return {
    contentRef,
    innerRef,
    autoScroll,
    setAutoScroll,
    disableAutoScroll,
    performAutoScroll,
    jumpToBottom,
    handleScroll,
    markUserInteraction,
  };
}
