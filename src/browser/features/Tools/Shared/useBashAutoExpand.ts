import { useLayoutEffect, useRef } from "react";

import type { ToolStatus } from "./toolUtils";

const FAST_COMMAND_FLASH_DELAY_MS = 300;

/**
 * Keeps the latest streaming bash readable without flashing short commands:
 * hydrated rows that already outlived the flash window expand before paint,
 * while freshly-started rows wait for that same window before expanding.
 * Manual user toggles pin the row, and auto-expanded rows collapse only when a
 * different bash becomes the latest streaming bash.
 */
export function useBashAutoExpand(options: {
  isLatestStreamingBash: boolean;
  hasReplacementStreamingBash: boolean;
  status: ToolStatus;
  /** Timestamp from the tool part. Used to distinguish hydrated long-running rows from fresh mounts. */
  startedAt?: number;
  setExpanded: (expanded: boolean) => void;
  /** Set by the row when the user clicks the header. Pinned thereafter. */
  userToggledRef: React.MutableRefObject<boolean>;
}): void {
  const {
    isLatestStreamingBash,
    hasReplacementStreamingBash,
    status,
    startedAt,
    setExpanded,
    userToggledRef,
  } = options;

  // Track that we triggered an auto-expand so we know to auto-collapse the row
  // when a different bash takes over.
  const wasAutoExpandedRef = useRef(false);
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFreshMountRef = useRef(true);

  useLayoutEffect(() => {
    const clearExpandTimer = () => {
      if (expandTimerRef.current) {
        clearTimeout(expandTimerRef.current);
        expandTimerRef.current = null;
      }
    };
    const isFreshMount = isFreshMountRef.current;
    isFreshMountRef.current = false;

    if (userToggledRef.current) {
      return clearExpandTimer;
    }

    if (isLatestStreamingBash && status === "executing") {
      const hasOutlivedFlashWindow =
        typeof startedAt === "number" && Date.now() - startedAt >= FAST_COMMAND_FLASH_DELAY_MS;
      if (isFreshMount && hasOutlivedFlashWindow) {
        setExpanded(true);
        wasAutoExpandedRef.current = true;
        return clearExpandTimer;
      }

      if (!wasAutoExpandedRef.current && !expandTimerRef.current) {
        expandTimerRef.current = setTimeout(() => {
          expandTimerRef.current = null;
          if (!userToggledRef.current) {
            setExpanded(true);
            wasAutoExpandedRef.current = true;
          }
        }, FAST_COMMAND_FLASH_DELAY_MS);
      }
      return clearExpandTimer;
    }

    clearExpandTimer();
    if (wasAutoExpandedRef.current && hasReplacementStreamingBash) {
      setExpanded(false);
      wasAutoExpandedRef.current = false;
    }
    return undefined;
  }, [
    isLatestStreamingBash,
    hasReplacementStreamingBash,
    status,
    startedAt,
    setExpanded,
    userToggledRef,
  ]);
}
