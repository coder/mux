import React, { useLayoutEffect, useRef } from "react";
import {
  clearLayoutStackHeight,
  getLayoutStackSignature,
  getReservedLayoutStackHeightPx,
  measureLayoutStackHeightPx,
  rememberLayoutStackHeight,
  type LayoutStackItem,
} from "./layoutStack";

/**
 * Shared lane for a stack of layout-affecting transcript chrome. Previously split
 * into `TranscriptTailStack` (top-aligned, scroll-pinning) and
 * `ChatInputDecorationStack` (bottom-aligned, measurement-only) which shared ~85%
 * of their machinery — the per-workspace reserved-height memory, the RO settle
 * dance, and the hydration bookkeeping.
 *
 * Differences are now expressed as props:
 *  - `align` picks between `justify-start` (tail, above the composer's opposite
 *    side of the transcript) and `justify-end` (composer decoration).
 *  - `overflowAnchor="none"` opts the tail lane out of browser scroll anchoring
 *    so a newly-inserted tail row (streaming barrier, etc.) can't win the anchor
 *    heuristic and flash the layout underneath.
 *  - `onStickToBottom` is called whenever the lane's layout signature or its
 *    measured content height changes. Callers use it to pin the transcript
 *    viewport to the bottom; omitting it makes this a pure measurement lane.
 */
interface LayoutStackLaneProps {
  workspaceId: string;
  isHydrating: boolean;
  items: readonly LayoutStackItem[];
  align: "start" | "end";
  overflowAnchor?: "none";
  /**
   * Optional pin callback invoked when the lane's identity/height changes. The
   * lane doesn't care how the caller pins; it only fires the signal synchronously
   * from a layout effect so the pin runs before paint.
   */
  onStickToBottom?: () => void;
  dataComponent?: string;
}

export const LayoutStackLane: React.FC<LayoutStackLaneProps> = (props) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const stackHeightByWorkspaceIdRef = useRef(new Map<string, number>());
  const lastMeasuredStackHeightRef = useRef(0);
  const observedHeightRef = useRef<number | null>(null);
  const previousLayoutSignatureRef = useRef<string | null>(null);

  // Hide the callback inside a ref so the RO effect's dep list doesn't depend
  // on a function identity that callers re-create every render.
  const onStickToBottomRef = useRef(props.onStickToBottom);
  onStickToBottomRef.current = props.onStickToBottom;

  const hasItems = props.items.length > 0;
  const layoutSignature = `${props.workspaceId}:${getLayoutStackSignature(props.items)}`;
  const reservedStackHeightPx = getReservedLayoutStackHeightPx({
    workspaceId: props.workspaceId,
    isHydrating: props.isHydrating,
    stackHeightByWorkspaceId: stackHeightByWorkspaceIdRef.current,
    fallbackStackHeightPx: lastMeasuredStackHeightRef.current,
  });

  // Pin on layout-signature changes (a new item appeared/disappeared or reordered).
  useLayoutEffect(() => {
    if (previousLayoutSignatureRef.current === layoutSignature) {
      return;
    }
    previousLayoutSignatureRef.current = layoutSignature;
    onStickToBottomRef.current?.();
  }, [layoutSignature]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) {
      observedHeightRef.current = null;
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextHeight = measureLayoutStackHeightPx(content, entries[0]?.contentRect.height);
      const previousObservedHeight = observedHeightRef.current;
      observedHeightRef.current = nextHeight;

      if (nextHeight === 0) {
        // Some owners (e.g. background-process dialogs) stay mounted while
        // rendering nothing. Only drop the reservation after hydration ends —
        // transient zero-height observations during hydration must not clobber
        // the remembered real height.
        if (!props.isHydrating) {
          clearLayoutStackHeight(
            props.workspaceId,
            stackHeightByWorkspaceIdRef.current,
            lastMeasuredStackHeightRef
          );
        }
      } else {
        rememberLayoutStackHeight(
          props.workspaceId,
          nextHeight,
          stackHeightByWorkspaceIdRef.current,
          lastMeasuredStackHeightRef
        );
      }

      if (previousObservedHeight === nextHeight) {
        return;
      }
      if (previousObservedHeight === null && nextHeight === 0) {
        return;
      }
      // Some lane items (notably active compaction/streaming barriers during chat open)
      // mount as zero-height placeholders and become visible before ResizeObserver has
      // delivered an initial measurement. Treat the first non-zero observation as a
      // layout change so the transcript still lands at the real tail.
      onStickToBottomRef.current?.();
    });

    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [props.isHydrating, props.workspaceId]);

  // Post-hydration settle: once we're no longer hydrating and have no items, clear
  // any cached height so the next hydration doesn't reserve stale space.
  useLayoutEffect(() => {
    if (props.isHydrating) {
      return;
    }

    if (!hasItems) {
      observedHeightRef.current = 0;
      clearLayoutStackHeight(
        props.workspaceId,
        stackHeightByWorkspaceIdRef.current,
        lastMeasuredStackHeightRef
      );
      return;
    }

    const content = contentRef.current;
    if (!content) {
      return;
    }

    const settledHeightPx = measureLayoutStackHeightPx(content);
    observedHeightRef.current = settledHeightPx;
    if (settledHeightPx === 0) {
      clearLayoutStackHeight(
        props.workspaceId,
        stackHeightByWorkspaceIdRef.current,
        lastMeasuredStackHeightRef
      );
    }
  }, [hasItems, props.isHydrating, props.workspaceId]);

  if (!hasItems && reservedStackHeightPx === null) {
    return null;
  }

  const style: React.CSSProperties = {};
  if (reservedStackHeightPx !== null) {
    style.minHeight = `${reservedStackHeightPx}px`;
  }
  if (props.overflowAnchor === "none") {
    style.overflowAnchor = "none";
  }

  return (
    <div
      className={
        props.align === "end" ? "flex flex-col justify-end" : "flex flex-col justify-start"
      }
      data-component={props.dataComponent}
      style={style}
    >
      <div ref={contentRef}>
        {props.items.map((item) => (
          <React.Fragment key={item.key}>{item.node}</React.Fragment>
        ))}
      </div>
    </div>
  );
};
