import React, { useLayoutEffect, useRef, useState } from "react";

interface HydrationStablePaneProps {
  workspaceId: string;
  isHydrating: boolean;
  className?: string;
  dataComponent?: string;
  children: React.ReactNode;
}

export const HydrationStablePane: React.FC<HydrationStablePaneProps> = (props) => {
  const paneRef = useRef<HTMLDivElement>(null);
  const paneHeightByWorkspaceIdRef = useRef(new Map<string, number>());
  const lastMeasuredPaneHeightRef = useRef(0);
  const [reservedPaneHeightPx, setReservedPaneHeightPx] = useState<number | null>(null);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextHeight = Math.max(
        0,
        Math.round(entries[0]?.contentRect.height ?? pane.getBoundingClientRect().height)
      );
      lastMeasuredPaneHeightRef.current = nextHeight;
      paneHeightByWorkspaceIdRef.current.set(props.workspaceId, nextHeight);
    });

    observer.observe(pane);
    return () => {
      observer.disconnect();
    };
  }, [props.workspaceId]);

  useLayoutEffect(() => {
    if (!props.isHydrating) {
      setReservedPaneHeightPx(null);
      return;
    }

    const cachedPaneHeight = paneHeightByWorkspaceIdRef.current.get(props.workspaceId);
    const fallbackPaneHeight = lastMeasuredPaneHeightRef.current;
    const reservedPaneHeight = cachedPaneHeight ?? fallbackPaneHeight;

    // Keep the whole composer region steady while workspace hydration catches up. The shell-level
    // fix stops the input from disappearing entirely, but workspace-specific banners/review chips
    // above the textarea can still collapse and re-expand during a switch, which looks like a
    // vertical tear in Electron. Hold the most recent pane height until hydration finishes.
    setReservedPaneHeightPx(reservedPaneHeight > 0 ? reservedPaneHeight : null);
  }, [props.workspaceId, props.isHydrating]);

  return (
    <div
      ref={paneRef}
      className={props.className}
      data-component={props.dataComponent}
      style={reservedPaneHeightPx !== null ? { minHeight: `${reservedPaneHeightPx}px` } : undefined}
    >
      {props.children}
    </div>
  );
};
