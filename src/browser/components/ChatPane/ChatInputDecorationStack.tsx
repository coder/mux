import React, { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/common/lib/utils";

interface ChatInputDecorationStackProps {
  workspaceId: string;
  isHydrating: boolean;
  items: React.ReactNode[];
  className?: string;
  dataComponent?: string;
}

export const ChatInputDecorationStack: React.FC<ChatInputDecorationStackProps> = (props) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const stackHeightByWorkspaceIdRef = useRef(new Map<string, number>());
  const lastMeasuredStackHeightRef = useRef(0);
  const [reservedStackHeightPx, setReservedStackHeightPx] = useState<number | null>(null);
  const hasVisibleItems = props.items.length > 0;

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !hasVisibleItems) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextHeight = Math.max(
        0,
        Math.round(entries[0]?.contentRect.height ?? content.getBoundingClientRect().height)
      );
      lastMeasuredStackHeightRef.current = nextHeight;
      stackHeightByWorkspaceIdRef.current.set(props.workspaceId, nextHeight);
    });

    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [hasVisibleItems, props.workspaceId]);

  useLayoutEffect(() => {
    if (!props.isHydrating) {
      setReservedStackHeightPx(null);
      return;
    }

    const cachedStackHeight = stackHeightByWorkspaceIdRef.current.get(props.workspaceId);
    const fallbackStackHeight = lastMeasuredStackHeightRef.current;
    const reservedStackHeight = cachedStackHeight ?? fallbackStackHeight;

    // Keep the workspace-specific decoration lane steady while hydration catches up. Reserving the
    // whole composer pane let the textarea float inside a tall wrapper, which still looked like a
    // vertical tear. Scope the reservation to the lane above the input and keep the lane bottom-
    // aligned so the textarea seam stays put while TODO/review/queued banners repopulate.
    setReservedStackHeightPx(reservedStackHeight > 0 ? reservedStackHeight : null);
  }, [props.workspaceId, props.isHydrating]);

  if (!hasVisibleItems && reservedStackHeightPx === null) {
    return null;
  }

  return (
    <div
      className={cn("flex flex-col justify-end", props.className)}
      data-component={props.dataComponent}
      style={
        reservedStackHeightPx !== null ? { minHeight: `${reservedStackHeightPx}px` } : undefined
      }
    >
      <div ref={contentRef}>{props.items}</div>
    </div>
  );
};
