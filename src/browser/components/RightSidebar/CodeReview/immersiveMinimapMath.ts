export type LineCategory = "add" | "remove" | "context";

const MIN_THUMB_HEIGHT_PX = 24;

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max);
};

/**
 * Keep minimap line categories aligned with SelectableDiffRenderer display indices:
 * hunk headers are not selectable rows, so we skip them entirely.
 */
export const parseDiffLines = (content: string): LineCategory[] => {
  if (content.length === 0) {
    return [];
  }

  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const categories: LineCategory[] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) {
      continue;
    }

    if (line.startsWith("+")) {
      categories.push("add");
      continue;
    }

    if (line.startsWith("-")) {
      categories.push("remove");
      continue;
    }

    categories.push("context");
  }

  return categories;
};

export const getThumbMetrics = (
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  trackHeight: number
): { thumbTop: number; thumbHeight: number; maxThumbTop: number } => {
  const maxScroll = Math.max(1, scrollHeight - clientHeight);
  const thumbHeight = Math.max(
    MIN_THUMB_HEIGHT_PX,
    (clientHeight / Math.max(scrollHeight, 1)) * trackHeight
  );
  const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
  const thumbTop = clamp((scrollTop / maxScroll) * maxThumbTop, 0, maxThumbTop);

  return {
    thumbTop,
    thumbHeight,
    maxThumbTop,
  };
};

export const pointerYToLineIndex = (
  pointerY: number,
  trackHeight: number,
  totalLines: number
): number => {
  if (totalLines <= 0) {
    return 0;
  }

  const bandHeight = trackHeight / totalLines;
  const lineIndex = Math.floor(pointerY / Math.max(bandHeight, Number.MIN_VALUE));

  return clamp(lineIndex, 0, totalLines - 1);
};

export const scrollTopForLine = (
  lineIndex: number,
  totalLines: number,
  scrollHeight: number,
  clientHeight: number
): number => {
  const ratio = lineIndex / Math.max(totalLines - 1, 1);
  const maxScroll = Math.max(0, scrollHeight - clientHeight);

  return ratio * maxScroll;
};
