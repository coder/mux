import type { MutableRefObject, ReactNode } from "react";

export interface LayoutStackItem {
  key: string;
  node: ReactNode;
  /**
   * Optional layout-specific signature.
   * Use when an item stays mounted for state continuity but its rendered height can toggle
   * between zero and non-zero (for example, a hidden RetryBarrier that still tracks rollback).
   */
  layoutKey?: string;
}

interface ReservedLayoutStackHeightProps {
  workspaceId: string;
  isHydrating: boolean;
  stackHeightByWorkspaceId: Map<string, number>;
  fallbackStackHeightPx: number;
}

export function getLayoutStackSignature(
  items: ReadonlyArray<Pick<LayoutStackItem, "key" | "layoutKey">>
): string {
  return items.map((item) => item.layoutKey ?? item.key).join("|");
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

export function scrollElementToBottom(element: HTMLElement | null): void {
  if (!element) {
    return;
  }

  element.scrollTop = element.scrollHeight;
}
