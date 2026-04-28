import { useRef, useState, useCallback, useEffect } from "react";

function requestAutoScrollFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }

  return setTimeout(
    () => callback(typeof performance === "undefined" ? Date.now() : performance.now()),
    16
  ) as unknown as number;
}

function cancelAutoScrollFrame(frameId: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(frameId);
    return;
  }

  clearTimeout(frameId);
}

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
  // Tracks the most recent user-owned scroll intent signal (wheel/touch/keyboard/mouse)
  // so we can distinguish genuine transcript scrolling from our own scrollTop writes.
  const lastUserInteractionRef = useRef<number>(0);
  // Ref to avoid stale closures in async callbacks - always holds current autoScroll value
  const autoScrollRef = useRef<boolean>(true);
  // Track the ResizeObserver so we can disconnect it when the element unmounts
  const observerRef = useRef<ResizeObserver | null>(null);
  // Debounce timer for "scroll settled" detection — fires after scrolling stops
  // to catch cases where iOS momentum/inertial scrolling reaches the bottom but
  // the user-interaction window (100ms after last touchmove) has already expired.
  const scrollSettledTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Discrete jump/open actions get two frame follow-up pins. The synchronous pin owns
  // the current commit, while these catch late browser/layout work that may not trigger
  // a ResizeObserver callback during chat hydration. This is intentionally not used for
  // every streaming delta, avoiding the old message-driven RAF loop that caused tail jitter.
  const jumpFollowUpFrameIdsRef = useRef<number[]>([]);
  // Set by disableAutoScroll() to prevent the scroll-settled debounce from
  // re-arming after programmatic scrolls (scrollIntoView, etc.). Cleared when
  // the user touches the scroll container (markUserInteraction).
  const programmaticDisableRef = useRef(false);

  // Sync ref with state to ensure callbacks always have latest value
  autoScrollRef.current = autoScroll;

  const clearScrollSettledTimer = useCallback(() => {
    if (scrollSettledTimerRef.current) {
      clearTimeout(scrollSettledTimerRef.current);
      scrollSettledTimerRef.current = null;
    }
  }, []);

  const cancelJumpFollowUpPins = useCallback(() => {
    for (const frameId of jumpFollowUpFrameIdsRef.current) {
      cancelAutoScrollFrame(frameId);
    }
    jumpFollowUpFrameIdsRef.current = [];
  }, []);

  const setAutoScrollEnabled = useCallback((enabled: boolean) => {
    setAutoScroll(enabled);
    autoScrollRef.current = enabled;
  }, []);

  const stickToBottom = useCallback(() => {
    const scrollContainer = contentRef.current;
    if (!scrollContainer) return;

    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    // Programmatic scroll writes can dispatch a later scroll event. Keep the baseline in
    // sync so recent user-intent state from a previous transcript cannot reinterpret
    // this write as a manual upward scroll and turn auto-scroll off during chat open.
    lastScrollTopRef.current = scrollContainer.scrollTop;
  }, []);

  const scheduleJumpFollowUpPins = useCallback(() => {
    cancelJumpFollowUpPins();

    const firstFrameId = requestAutoScrollFrame(() => {
      if (!autoScrollRef.current) {
        jumpFollowUpFrameIdsRef.current = [];
        return;
      }

      stickToBottom();
      const secondFrameId = requestAutoScrollFrame(() => {
        jumpFollowUpFrameIdsRef.current = [];
        if (autoScrollRef.current) {
          stickToBottom();
        }
      });
      jumpFollowUpFrameIdsRef.current = [secondFrameId];
    });

    jumpFollowUpFrameIdsRef.current = [firstFrameId];
  }, [cancelJumpFollowUpPins, stickToBottom]);

  // Callback ref for the inner content wrapper - sets up ResizeObserver when element mounts.
  // ResizeObserver fires after layout and before paint when the transcript's content size changes
  // (streamed markdown wrapping to a new line, Shiki highlighting, Mermaid SVG insertion, images,
  // live tool output, etc.). Pin synchronously in that callback: deferring the write to RAF leaves
  // one paint at the old scrollTop, which is exactly the vertical tear users notice at the tail.
  const innerRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }

      if (!element) return;

      const observer = new ResizeObserver(() => {
        if (!autoScrollRef.current || !contentRef.current) return;

        stickToBottom();
      });

      observer.observe(element);
      observerRef.current = observer;
    },
    [stickToBottom]
  );

  const jumpToBottom = useCallback(() => {
    // This is an explicit programmatic ownership reset (workspace open, send, jump button).
    // Clear stale user-scroll telemetry before pinning so scroll events emitted by the
    // browser for this write do not inherit intent from the previously visible chat.
    clearScrollSettledTimer();
    programmaticDisableRef.current = false;
    lastUserInteractionRef.current = 0;

    // Enable auto-scroll first so ResizeObserver will handle subsequent changes
    setAutoScrollEnabled(true);

    // Immediate scroll for content that's already rendered, followed by two frame-scoped
    // pins for late layout during chat hydration/open. Those follow-ups are cancelled as
    // soon as the user disables auto-scroll.
    stickToBottom();
    scheduleJumpFollowUpPins();
  }, [clearScrollSettledTimer, scheduleJumpFollowUpPins, setAutoScrollEnabled, stickToBottom]);

  // Programmatic disable — clears any pending scroll-settled recovery timer so
  // intentional disables (navigate-to-message, edit-message) aren't undone by the
  // debounced re-enable. Use this instead of setAutoScroll(false) for explicit
  // code-driven disables; the scroll handler's own disable (user scrolls up)
  // deliberately does NOT clear the timer so the debounce can recover when the
  // user scrolls back to the bottom.
  const disableAutoScroll = useCallback(() => {
    setAutoScrollEnabled(false);
    programmaticDisableRef.current = true;
    clearScrollSettledTimer();
    cancelJumpFollowUpPins();
  }, [cancelJumpFollowUpPins, clearScrollSettledTimer, setAutoScrollEnabled]);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const element = e.currentTarget;
      const currentScrollTop = element.scrollTop;
      const threshold = 100;
      const isAtBottom = element.scrollHeight - currentScrollTop - element.clientHeight < threshold;

      // Safety net: when auto-scroll is disabled and scrolling stops at the bottom,
      // re-enable it. Only armed on downward movement, but NOT cleared on upward
      // events — on iOS, rubber-band bounce and momentum deceleration produce
      // upward scroll events at the tail end, which would cancel the timer and
      // prevent recovery. The timer always re-checks position when it fires, so
      // stale timers from earlier downward events are harmless.
      const isMovingDown = currentScrollTop > lastScrollTopRef.current;
      if (!autoScrollRef.current && isMovingDown && !programmaticDisableRef.current) {
        clearScrollSettledTimer();
        scrollSettledTimerRef.current = setTimeout(() => {
          scrollSettledTimerRef.current = null;
          if (contentRef.current && !autoScrollRef.current) {
            const el = contentRef.current;
            const settledAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
            if (settledAtBottom) {
              setAutoScrollEnabled(true);
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

      // Detect iOS rubber-band overscroll: during the bounce at the bottom,
      // scrollTop + clientHeight exceeds scrollHeight (the content is "past" the
      // physical end). The bounce-back decreases scrollTop, which looks like
      // scrolling up but shouldn't disable auto-scroll.
      const maxScrollTop = element.scrollHeight - element.clientHeight;
      const isRubberBanding = lastScrollTopRef.current > maxScrollTop;

      if (isScrollingUp && !isRubberBanding) {
        // Disable auto-scroll when scrolling up, unless this is just iOS
        // rubber-band bounce-back from the bottom edge.
        setAutoScrollEnabled(false);
        // Cancel any pending scroll-settled timer — the user explicitly scrolled
        // up, so we should not re-enable auto-scroll even if we're near the bottom.
        clearScrollSettledTimer();
        cancelJumpFollowUpPins();
      } else if (isScrollingDown && isAtBottom) {
        // Only enable auto-scroll if scrolling down AND reached the bottom
        setAutoScrollEnabled(true);
      }
      // If scrolling down but not at bottom, auto-scroll remains disabled

      // Update last scroll position
      lastScrollTopRef.current = currentScrollTop;
    },
    [cancelJumpFollowUpPins, clearScrollSettledTimer, setAutoScrollEnabled]
  );

  const markUserInteraction = useCallback(() => {
    lastUserInteractionRef.current = Date.now();
    // Clear programmatic disable flag — the user is now interacting with the
    // scroll container, so the debounced scroll-settled recovery can re-arm.
    programmaticDisableRef.current = false;
  }, []);

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      clearScrollSettledTimer();
      cancelJumpFollowUpPins();
    };
  }, [cancelJumpFollowUpPins, clearScrollSettledTimer]);

  return {
    contentRef,
    innerRef,
    autoScroll,
    disableAutoScroll,
    stickToBottom,
    jumpToBottom,
    handleScroll,
    markUserInteraction,
  };
}
