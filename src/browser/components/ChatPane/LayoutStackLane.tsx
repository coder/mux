import React, { useLayoutEffect, useRef } from "react";
import {
  clearLayoutStackHeight,
  getReservedLayoutStackHeightPx,
  measureLayoutStackHeightPx,
  rememberLayoutStackHeight,
  type ChatInputDecorationStackItem,
  type LayoutStackLaneKind,
  type TranscriptTailStackItem,
} from "./layoutStack";

interface LayoutStackLaneConfig {
  align: "start" | "end";
  dataComponent: string;
  overflowAnchor?: "none";
}

const LAYOUT_STACK_LANE_CONFIG: Record<LayoutStackLaneKind, LayoutStackLaneConfig> = {
  "transcript-tail": {
    align: "start",
    dataComponent: "TranscriptTailStack",
    overflowAnchor: "none",
  },
  "composer-decoration": {
    align: "end",
    dataComponent: "ChatInputDecorationStack",
  },
};

interface BaseLayoutStackLaneProps {
  workspaceId: string;
  isHydrating: boolean;
}

interface TranscriptTailStackLaneProps extends BaseLayoutStackLaneProps {
  items: readonly TranscriptTailStackItem[];
}

interface ChatInputDecorationStackLaneProps extends BaseLayoutStackLaneProps {
  items: readonly ChatInputDecorationStackItem[];
}

type LayoutStackLaneProps =
  | (TranscriptTailStackLaneProps & { lane: "transcript-tail" })
  | (ChatInputDecorationStackLaneProps & { lane: "composer-decoration" });

/**
 * Shared implementation for layout-affecting chat chrome. Public callers choose a
 * semantic lane through the wrappers below instead of passing low-level layout knobs.
 *
 * Lane semantics are intentionally centralized here:
 *  - transcript tail: content that belongs in the scrollport after messages and
 *    must opt out of browser scroll anchoring.
 *  - composer decoration: persistent workspace chrome above the textarea whose
 *    height changes are handled by the transcript scroll owner from outside the
 *    scrollport.
 *
 * This keeps future warnings/banners from accidentally reintroducing the class of
 * flash where appending a message moves a live tail row before bottom-lock settles.
 */
const LayoutStackLane: React.FC<LayoutStackLaneProps> = (props) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const stackHeightByWorkspaceIdRef = useRef(new Map<string, number>());
  const lastMeasuredStackHeightRef = useRef(0);
  const laneConfig = LAYOUT_STACK_LANE_CONFIG[props.lane];

  const hasItems = props.items.length > 0;
  const reservedStackHeightPx = getReservedLayoutStackHeightPx({
    workspaceId: props.workspaceId,
    isHydrating: props.isHydrating,
    stackHeightByWorkspaceId: stackHeightByWorkspaceIdRef.current,
    fallbackStackHeightPx: lastMeasuredStackHeightRef.current,
  });

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextHeight = measureLayoutStackHeightPx(content, entries[0]?.contentRect.height);
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
    });

    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [hasItems, props.isHydrating, props.workspaceId]);

  // Post-hydration settle: once we're no longer hydrating and have no items, clear
  // any cached height so the next hydration doesn't reserve stale space.
  useLayoutEffect(() => {
    if (props.isHydrating) {
      return;
    }

    if (!hasItems) {
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
  if (laneConfig.overflowAnchor === "none") {
    style.overflowAnchor = "none";
  }

  return (
    <div
      className={
        laneConfig.align === "end" ? "flex flex-col justify-end" : "flex flex-col justify-start"
      }
      data-component={laneConfig.dataComponent}
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

export const TranscriptTailStackLane: React.FC<TranscriptTailStackLaneProps> = (props) => {
  return <LayoutStackLane {...props} lane="transcript-tail" />;
};

export const ChatInputDecorationStackLane: React.FC<ChatInputDecorationStackLaneProps> = (
  props
) => {
  return <LayoutStackLane {...props} lane="composer-decoration" />;
};
