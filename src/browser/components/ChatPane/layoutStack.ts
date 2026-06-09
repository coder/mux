import type { ReactNode } from "react";

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
