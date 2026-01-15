import { useEffect, type RefObject } from "react";

/**
 * Converts vertical wheel scroll to horizontal scroll on an overflow-x container.
 * Useful for tab strips and other horizontal scrollable areas.
 */
export function useHorizontalWheelScroll(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      // Only intercept if there's horizontal overflow
      if (el.scrollWidth <= el.clientWidth) return;

      // Convert vertical scroll to horizontal
      if (e.deltaY !== 0) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [ref]);
}
