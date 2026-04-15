import React, { useLayoutEffect, useRef } from "react";
import {
  clearLayoutStackHeight,
  getReservedLayoutStackHeightPx,
  measureLayoutStackHeightPx,
  rememberLayoutStackHeight,
  type LayoutStackItem,
} from "./layoutStack";

interface ChatInputDecorationStackProps {
  workspaceId: string;
  isHydrating: boolean;
  items: readonly LayoutStackItem[];
  dataComponent?: string;
}

export const ChatInputDecorationStack: React.FC<ChatInputDecorationStackProps> = (props) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const stackHeightByWorkspaceIdRef = useRef(new Map<string, number>());
  const lastMeasuredStackHeightRef = useRef(0);
  const hasItems = props.items.length > 0;
  const reservedStackHeightPx = getReservedLayoutStackHeightPx({
    workspaceId: props.workspaceId,
    isHydrating: props.isHydrating,
    stackHeightByWorkspaceId: stackHeightByWorkspaceIdRef.current,
    fallbackStackHeightPx: lastMeasuredStackHeightRef.current,
  });

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !hasItems) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextHeight = measureLayoutStackHeightPx(content, entries[0]?.contentRect.height);
      if (nextHeight === 0) {
        if (!props.isHydrating) {
          clearLayoutStackHeight(
            props.workspaceId,
            stackHeightByWorkspaceIdRef.current,
            lastMeasuredStackHeightRef
          );
        }
        return;
      }

      // Some decoration owners stay mounted while temporarily rendering nothing (for example,
      // background process dialogs). Ignore zero-height observations during hydration so a
      // transient empty lane cannot overwrite the last real measurement and drop the temporary
      // reservation early, but still remember settled zero-height states after hydration ends.
      rememberLayoutStackHeight(
        props.workspaceId,
        nextHeight,
        stackHeightByWorkspaceIdRef.current,
        lastMeasuredStackHeightRef
      );
    });

    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [hasItems, props.isHydrating, props.workspaceId]);

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

  // Keep the workspace-specific decoration lane steady while hydration catches up. Reserving the
  // whole composer pane let the textarea float inside a tall wrapper, which still looked like a
  // vertical tear. Scope the reservation to the lane above the input and keep the lane bottom-
  // aligned so the textarea seam stays put while TODO/review/queued banners repopulate.
  if (!hasItems && reservedStackHeightPx === null) {
    return null;
  }

  return (
    <div
      className="flex flex-col justify-end"
      data-component={props.dataComponent}
      style={
        reservedStackHeightPx !== null ? { minHeight: `${reservedStackHeightPx}px` } : undefined
      }
    >
      <div ref={contentRef}>
        {props.items.map((item) => (
          <React.Fragment key={item.key}>{item.node}</React.Fragment>
        ))}
      </div>
    </div>
  );
};
