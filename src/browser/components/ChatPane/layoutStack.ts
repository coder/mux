import type { MutableRefObject, ReactNode } from "react";

export type LayoutStackLaneKind = "transcript-tail" | "composer-decoration";

interface LayoutStackItemInit {
  key: string;
  node: ReactNode;
}

export interface LayoutStackItem<
  Lane extends LayoutStackLaneKind = LayoutStackLaneKind,
> extends LayoutStackItemInit {
  readonly layoutLane: Lane;
}

export type TranscriptTailStackItem = LayoutStackItem<"transcript-tail">;
export type ChatInputDecorationStackItem = LayoutStackItem<"composer-decoration">;

function createLayoutStackItem<Lane extends LayoutStackLaneKind>(
  layoutLane: Lane,
  item: LayoutStackItemInit
): LayoutStackItem<Lane> {
  return { ...item, layoutLane };
}

// Choosing a factory is the layout contract: transcript-tail items may move the
// scrollport bottom, while composer decorations live in the stable chrome above
// the textarea. Making that choice explicit keeps persistent warnings from being
// accidentally appended inside the transcript again.
export function createTranscriptTailStackItem(item: LayoutStackItemInit): TranscriptTailStackItem {
  return createLayoutStackItem("transcript-tail", item);
}

export function createChatInputDecorationStackItem(
  item: LayoutStackItemInit
): ChatInputDecorationStackItem {
  return createLayoutStackItem("composer-decoration", item);
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
