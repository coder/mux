import { useEffect, useState, useRef, type RefObject } from "react";

interface Size {
  width: number;
  height: number;
}

/**
 * Observes an element's size changes using ResizeObserver with throttling
 * to prevent excessive re-renders during continuous resize operations.
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
