import { useEffect, useState, useRef, type RefObject } from "react";

interface Size {
  width: number;
  height: number;
}

/**
 * Observes an element's size changes using ResizeObserver with RAF throttling.
 *
 * Use this hook when you need to track an element's dimensions reactively.
 * Updates are throttled to one per animation frame and rounded to prevent
 * sub-pixel re-renders.
 *
 * **When to use this vs raw ResizeObserver:**
 * - Use this hook when you need the size as React state
 * - Use raw ResizeObserver when you need to trigger side effects (e.g., auto-scroll)
 *   but wrap layout reads in requestAnimationFrame to avoid forced reflows
 *
 * @see useOverflowDetection - For detecting content overflow (scrollHeight > clientHeight)
 *
 * @example
 * ```tsx
 * const ref = useRef<HTMLDivElement>(null);
 * const size = useResizeObserver(ref);
 *
 * return (
 *   <div ref={ref}>
 *     {size && `${size.width}x${size.height}`}
 *   </div>
 * );
 * ```
 */
export function useResizeObserver(ref: RefObject<HTMLElement>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      // Throttle updates using requestAnimationFrame
      // Only one update per frame, preventing excessive re-renders
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }

      frameRef.current = requestAnimationFrame(() => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          // Round to nearest pixel to prevent sub-pixel re-renders
          const roundedWidth = Math.round(width);
          const roundedHeight = Math.round(height);

          setSize((prev) => {
            // Only update if size actually changed
            if (prev?.width === roundedWidth && prev?.height === roundedHeight) {
              return prev;
            }
            return { width: roundedWidth, height: roundedHeight };
          });
        }
        frameRef.current = null;
      });
    });

    observer.observe(element);

    // Set initial size
    const { width, height } = element.getBoundingClientRect();
    setSize({ width: Math.round(width), height: Math.round(height) });

    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
      observer.disconnect();
    };
  }, [ref]);

  return size;
}
