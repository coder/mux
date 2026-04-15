import React, { useLayoutEffect, useRef } from "react";
import {
  clearLayoutStackHeight,
  getLayoutStackSignature,
  getReservedLayoutStackHeightPx,
  measureLayoutStackHeightPx,
  rememberLayoutStackHeight,
  scrollElementToBottom,
  type LayoutStackItem,
} from "./layoutStack";

interface TranscriptTailStackProps {
  workspaceId: string;
  isHydrating: boolean;
  autoScroll: boolean;
  transcriptViewportRef: React.RefObject<HTMLDivElement | null>;
  items: readonly LayoutStackItem[];
  dataComponent?: string;
}

export const TranscriptTailStack: React.FC<TranscriptTailStackProps> = (props) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const stackHeightByWorkspaceIdRef = useRef(new Map<string, number>());
  const lastMeasuredStackHeightRef = useRef(0);
  const observedHeightRef = useRef<number | null>(null);
  const previousLayoutSignatureRef = useRef<string | null>(null);
  const hasItems = props.items.length > 0;
  const layoutSignature = `${props.workspaceId}:${getLayoutStackSignature(props.items)}`;
  const reservedStackHeightPx = getReservedLayoutStackHeightPx({
    workspaceId: props.workspaceId,
    isHydrating: props.isHydrating,
    stackHeightByWorkspaceId: stackHeightByWorkspaceIdRef.current,
    fallbackStackHeightPx: lastMeasuredStackHeightRef.current,
  });

  useLayoutEffect(() => {
    if (previousLayoutSignatureRef.current === layoutSignature) {
      return;
    }
    previousLayoutSignatureRef.current = layoutSignature;

    if (!props.autoScroll) {
      return;
    }

    scrollElementToBottom(props.transcriptViewportRef.current);
  }, [layoutSignature, props.autoScroll, props.transcriptViewportRef]);

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

      if (
        !props.autoScroll ||
        previousObservedHeight === null ||
        previousObservedHeight === nextHeight
      ) {
        return;
      }

      scrollElementToBottom(props.transcriptViewportRef.current);
    });

    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [props.autoScroll, props.isHydrating, props.transcriptViewportRef, props.workspaceId]);

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

  // Keep all volatile transcript-tail chrome on one seam owner. The message list sits above this
  // lane, so top-align the contents inside any reserved hydration space to keep the seam under the
  // last transcript row stationary while retry/streaming/warning rows repopulate.
  if (!hasItems && reservedStackHeightPx === null) {
    return null;
  }

  return (
    <div
      className="flex flex-col justify-start"
      data-component={props.dataComponent}
      style={
        reservedStackHeightPx !== null
          ? { minHeight: `${reservedStackHeightPx}px`, overflowAnchor: "none" }
          : { overflowAnchor: "none" }
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
