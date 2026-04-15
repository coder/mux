import type { ReactNode } from "react";

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

export function getLayoutStackSignature(
  items: ReadonlyArray<Pick<LayoutStackItem, "key" | "layoutKey">>
): string {
  return items.map((item) => item.layoutKey ?? item.key).join("|");
}
