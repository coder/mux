import React, { useLayoutEffect, useRef } from "react";

interface ChatInputDecorationStackProps {
  workspaceId: string;
  isHydrating: boolean;
  items: React.ReactNode[];
  dataComponent?: string;
}

function getReservedStackHeightPx(props: {
  workspaceId: string;
  isHydrating: boolean;
  stackHeightByWorkspaceId: Map<string, number>;
  fallbackStackHeightPx: number;
}): number | null {
  if (!props.isHydrating) {
    return null;
  }

  const reservedStackHeight =
    props.stackHeightByWorkspaceId.get(props.workspaceId) ?? props.fallbackStackHeightPx;
  return reservedStackHeight > 0 ? reservedStackHeight : null;
}

export const ChatInputDecorationStack: React.FC<ChatInputDecorationStackProps> = (props) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const stackHeightByWorkspaceIdRef = useRef(new Map<string, number>());
  const lastMeasuredStackHeightRef = useRef(0);
  const hasDecorationEntries = props.items.length > 0;
  const reservedStackHeightPx = getReservedStackHeightPx({
    workspaceId: props.workspaceId,
    isHydrating: props.isHydrating,
    stackHeightByWorkspaceId: stackHeightByWorkspaceIdRef.current,
    fallbackStackHeightPx: lastMeasuredStackHeightRef.current,
  });

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !hasDecorationEntries) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextHeight = Math.max(
        0,
        Math.round(entries[0]?.contentRect.height ?? content.getBoundingClientRect().height)
      );
      if (nextHeight === 0) {
        if (!props.isHydrating) {
          lastMeasuredStackHeightRef.current = 0;
          stackHeightByWorkspaceIdRef.current.set(props.workspaceId, 0);
        }
        return;
      }

      // Some decoration owners stay mounted while temporarily rendering nothing (for example,
      // background process dialogs). Ignore zero-height observations during hydration so a
      // transient empty lane cannot overwrite the last real measurement and drop the temporary
      // reservation early, but still remember settled zero-height states after hydration ends.
      lastMeasuredStackHeightRef.current = nextHeight;
      stackHeightByWorkspaceIdRef.current.set(props.workspaceId, nextHeight);
    });

    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [hasDecorationEntries, props.isHydrating, props.workspaceId]);

  useLayoutEffect(() => {
    if (props.isHydrating) {
      return;
    }

    if (!hasDecorationEntries) {
      lastMeasuredStackHeightRef.current = 0;
      stackHeightByWorkspaceIdRef.current.set(props.workspaceId, 0);
      return;
    }

    const content = contentRef.current;
    if (!content) {
      return;
    }

    const settledHeightPx = Math.max(0, Math.round(content.getBoundingClientRect().height));
    if (settledHeightPx === 0) {
      lastMeasuredStackHeightRef.current = 0;
      stackHeightByWorkspaceIdRef.current.set(props.workspaceId, 0);
    }
  }, [hasDecorationEntries, props.isHydrating, props.workspaceId]);

  // Keep the workspace-specific decoration lane steady while hydration catches up. Reserving the
  // whole composer pane let the textarea float inside a tall wrapper, which still looked like a
  // vertical tear. Scope the reservation to the lane above the input and keep the lane bottom-
  // aligned so the textarea seam stays put while TODO/review/queued banners repopulate.
  if (!hasDecorationEntries && reservedStackHeightPx === null) {
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
      <div ref={contentRef}>{props.items}</div>
    </div>
  );
};
