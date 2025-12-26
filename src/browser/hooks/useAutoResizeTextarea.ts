import { useLayoutEffect, type RefObject } from "react";

/**
 * Auto-resize a textarea to fit its content.
 * Uses useLayoutEffect to measure and set height synchronously before paint.
 */
export function useAutoResizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeightVh = 30
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // For empty/whitespace content, let CSS min-height handle sizing
    if (!value.trim()) {
      el.style.height = "";
      return;
    }

    // For non-empty content, measure and set height
    el.style.height = "auto";
    const max = window.innerHeight * (maxHeightVh / 100);
    el.style.height = Math.min(el.scrollHeight, max) + "px";
  }, [ref, value, maxHeightVh]);
}
