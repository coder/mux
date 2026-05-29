import { useEffect, useState, useRef, type RefObject } from "react";

/**
 * Detects whether an element's content overflows its visible area.
 *
 * Uses ResizeObserver with RAF-throttled layout reads to avoid forcing
 * synchronous layout during React's commit phase. This prevents the 100ms+
 * layout thrashing seen when reading scrollHeight/clientHeight directly
 * in ResizeObserver callbacks.
 *
 * @param ref - Ref to the scrollable container element
 * @param options.enabled - Whether to observe (default: true). Set to false to skip observation.
 * @returns Whether content overflows the container
 *
 * @example
 * ```tsx
 * const containerRef = useRef<HTMLDivElement>(null);
 * const isOverflowing = useOverflowDetection(containerRef);
 *
 * return (
 *   <div ref={containerRef} style={{ maxHeight: 400, overflow: 'hidden' }}>
 *     {content}
 *     {isOverflowing && <button onClick={expand}>Show more</button>}
 *   </div>
 * );
 * ```
 */
export function useOverflowDetection(
  ref: RefObject<HTMLElement | null>,
  options: { enabled?: boolean } = {}
): boolean {
  const { enabled = true } = options;
  const [isOverflowing, setIsOverflowing] = useState(false);
  const rafIdRef = useRef<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) {
      setIsOverflowing(false);
      return;
    }

    // Defer layout reads to next frame to avoid forcing synchronous layout
    // during React's commit phase (which can cause 100ms+ layout thrashing)
    const checkOverflow = () => {
      if (rafIdRef.current !== null) return; // Coalesce rapid calls
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (element.isConnected) {
          // +1 threshold handles sub-pixel rounding differences
          const overflows = element.scrollHeight > element.clientHeight + 1;
          setIsOverflowing((prev) => (prev === overflows ? prev : overflows));
        }
      });
    };

    checkOverflow();

    const observer = new ResizeObserver(checkOverflow);
    observer.observe(element);

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      observer.disconnect();
    };
  }, [ref, enabled]);

  return isOverflowing;
}
