import type { MutableRefObject, ReactNode } from "react";

export interface LayoutStackItem {
  key: string;
  node: ReactNode;
}

interface ReservedLayoutStackHeightProps {
  workspaceId: string;
  isHydrating: boolean;
  stackHeightByWorkspaceId: Map<string, number>;
  fallbackStackHeightPx: number;
}

export function getReservedLayoutStackHeightPx(
  props: ReservedLayoutStackHeightProps
): number | null {
  if (!props.isHydrating) {
    return null;
  }

  const reservedStackHeight =
    props.stackHeightByWorkspaceId.get(props.workspaceId) ?? props.fallbackStackHeightPx;
  return reservedStackHeight > 0 ? reservedStackHeight : null;
}

export function measureLayoutStackHeightPx(
  content: HTMLElement,
  observedHeightPx?: number | null
): number {
  return Math.max(0, Math.round(observedHeightPx ?? content.getBoundingClientRect().height));
}

export function rememberLayoutStackHeight(
  workspaceId: string,
  heightPx: number,
  stackHeightByWorkspaceId: Map<string, number>,
  lastMeasuredStackHeightRef: MutableRefObject<number>
): void {
  lastMeasuredStackHeightRef.current = heightPx;
  stackHeightByWorkspaceId.set(workspaceId, heightPx);
}

export function clearLayoutStackHeight(
  workspaceId: string,
  stackHeightByWorkspaceId: Map<string, number>,
  lastMeasuredStackHeightRef: MutableRefObject<number>
): void {
  lastMeasuredStackHeightRef.current = 0;
  stackHeightByWorkspaceId.set(workspaceId, 0);
}
