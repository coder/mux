import { useLayoutEffect, type RefObject } from "react";

/**
 * Auto-resize a contenteditable element to fit its content.
 * Uses useLayoutEffect to measure and set height synchronously before paint.
 */
export function useAutoResizeContentEditable(
  ref: RefObject<HTMLElement | null>,
  value: string,
  maxHeightVh = 30
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Always measure to avoid layout shift when placeholder disappears.
    el.style.height = "auto";
    const max = window.innerHeight * (maxHeightVh / 100);
    el.style.height = Math.min(el.scrollHeight, max) + "px";
  }, [ref, value, maxHeightVh]);
}
