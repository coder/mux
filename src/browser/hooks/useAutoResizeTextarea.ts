import { useLayoutEffect, useRef, type RefObject } from "react";

function preservesPreviousValueAsInsertion(previousValue: string, nextValue: string): boolean {
  if (nextValue.length <= previousValue.length) {
    return false;
  }

  let sharedPrefixLength = 0;
  while (
    sharedPrefixLength < previousValue.length &&
    previousValue[sharedPrefixLength] === nextValue[sharedPrefixLength]
  ) {
    sharedPrefixLength += 1;
  }

  let sharedSuffixLength = 0;
  while (
    sharedSuffixLength < previousValue.length - sharedPrefixLength &&
    previousValue[previousValue.length - 1 - sharedSuffixLength] ===
      nextValue[nextValue.length - 1 - sharedSuffixLength]
  ) {
    sharedSuffixLength += 1;
  }

  return sharedPrefixLength + sharedSuffixLength === previousValue.length;
}

/**
 * Auto-resize a textarea to fit its content.
 * Uses useLayoutEffect to measure and set height synchronously before paint.
 */
export function useAutoResizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeightVh = 30
): void {
  const previousValueRef = useRef<string | null>(null);
  const previousMaxRef = useRef<number | null>(null);
  const appliedHeightRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const max = window.innerHeight * (maxHeightVh / 100);
    const previousValue = previousValueRef.current;
    const previousMax = previousMaxRef.current;
    const canOnlyGrow =
      previousValue !== null &&
      previousMax === max &&
      preservesPreviousValueAsInsertion(previousValue, value);

    let nextHeight: number;
    if (canOnlyGrow) {
      // User typing in a large transcript should not reset the textarea to "auto" on
      // every key. That temporary height mutation forces the surrounding flex column
      // (including all chat rows) through layout even when the composer height is
      // unchanged. For pure insertions we only need to grow if scrollHeight exceeds
      // the currently applied height; shrinking paths still use the full reset below.
      const appliedHeight = appliedHeightRef.current ?? Number.parseFloat(el.style.height);
      const scrollHeight = Math.min(el.scrollHeight, max);
      nextHeight = Number.isFinite(appliedHeight)
        ? Math.max(appliedHeight, scrollHeight)
        : scrollHeight;
    } else {
      // Deletions, same-length replacements, viewport changes, and first render may
      // shrink the textarea, so measure from its intrinsic content height.
      el.style.height = "auto";
      nextHeight = Math.min(el.scrollHeight, max);
    }

    if (appliedHeightRef.current !== nextHeight) {
      el.style.height = `${nextHeight}px`;
      appliedHeightRef.current = nextHeight;
    }

    previousValueRef.current = value;
    previousMaxRef.current = max;
  }, [ref, value, maxHeightVh]);
}
