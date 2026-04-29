import { useEffect, useLayoutEffect, useRef } from "react";

import type { ToolStatus } from "./toolUtils";

const FAST_COMMAND_FLASH_DELAY_MS = 300;

/**
 * Manages auto-expand/collapse of a bash tool row based on whether it's the
 * latest streaming bash in the workspace.
 *
 * Two distinct cases:
 *
 * 1. **Chat-open with an already-streaming bash.** The row mounts with
 *    `isLatestStreamingBash && status === "executing"`. The bash has clearly
 *    been running for some time (otherwise the chat wouldn't be in this
 *    state when opened), so flash protection is not needed. Expand immediately
 *    in a layout effect so the user does not perceive a delay between the chat
 *    appearing and the bash output being readable.
 *
 * 2. **In-chat new bash.** A bash transitions to executing while the user is
 *    already mounted in the chat. Delay the expand by 300 ms so commands that
 *    complete in under that window don't briefly expand and re-collapse,
 *    preventing a layout flash for fast-completing commands.
 *
 * The hook also auto-collapses the row when a new bash takes over and respects
 * any manual user toggle (a manual click pins the row's expanded state).
 */
export function useBashAutoExpand(options: {
  isLatestStreamingBash: boolean;
  latestStreamingBashId: string | null;
  status: ToolStatus;
  setExpanded: (expanded: boolean) => void;
  /** Set by the row when the user clicks the header. Pinned thereafter. */
  userToggledRef: React.MutableRefObject<boolean>;
}): void {
  const { isLatestStreamingBash, latestStreamingBashId, status, setExpanded, userToggledRef } =
    options;

  // Track that we triggered an auto-expand so we know to auto-collapse the row
  // when a different bash takes over.
  const wasAutoExpandedRef = useRef(false);
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFreshMountRef = useRef(true);

  useLayoutEffect(() => {
    const isFreshMount = isFreshMountRef.current;
    isFreshMountRef.current = false;

    if (userToggledRef.current) return;

    if (isLatestStreamingBash && status === "executing") {
      if (isFreshMount) {
        // Chat-open with already-streaming bash: expand synchronously before paint.
        setExpanded(true);
        wasAutoExpandedRef.current = true;
        return;
      }

      if (wasAutoExpandedRef.current) return;

      // In-chat new bash: delay expand to suppress flash for fast-completing commands.
      expandTimerRef.current = setTimeout(() => {
        if (!userToggledRef.current) {
          setExpanded(true);
          wasAutoExpandedRef.current = true;
        }
      }, FAST_COMMAND_FLASH_DELAY_MS);
      return;
    }

    // No longer the latest streaming bash: cancel any pending expand and collapse
    // if a NEW bash took over (latestStreamingBashId !== null && !== us).
    if (expandTimerRef.current) {
      clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
    if (wasAutoExpandedRef.current && latestStreamingBashId !== null) {
      setExpanded(false);
      wasAutoExpandedRef.current = false;
    }
  }, [isLatestStreamingBash, latestStreamingBashId, status, setExpanded, userToggledRef]);

  useEffect(() => {
    return () => {
      if (expandTimerRef.current) {
        clearTimeout(expandTimerRef.current);
      }
    };
  }, []);
}
