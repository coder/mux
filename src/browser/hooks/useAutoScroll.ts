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

  // Sync ref with state to ensure callbacks always have latest value
  autoScrollRef.current = autoScroll;

  // Callback ref for the inner content wrapper - sets up ResizeObserver when element mounts.
  // ResizeObserver fires when the content size changes (Shiki highlighting, Mermaid, images, etc.),
  // allowing us to scroll to bottom even when async content renders after the initial mount.
  const innerRef = useCallback((element: HTMLDivElement | null) => {
    // Cleanup previous observer if any
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (!element) return;

    const observer = new ResizeObserver(() => {
      // Only auto-scroll if enabled - user may have scrolled up
      if (autoScrollRef.current && contentRef.current) {
        contentRef.current.scrollTop = contentRef.current.scrollHeight;
      }
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

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const element = e.currentTarget;
    const currentScrollTop = element.scrollTop;
    const threshold = 100;
    const isAtBottom = element.scrollHeight - currentScrollTop - element.clientHeight < threshold;

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
  }, []);

  return {
    contentRef,
    innerRef,
    autoScroll,
    setAutoScroll,
    performAutoScroll,
    jumpToBottom,
    handleScroll,
    markUserInteraction,
  };
}
