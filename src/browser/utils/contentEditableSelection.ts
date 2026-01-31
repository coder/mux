export interface SelectionRange {
  start: number;
  end: number;
}

type SelectionModifier = (
  alter: "move" | "extend",
  direction: "forward" | "backward",
  granularity: "character"
) => void;

interface SelectionWithModify extends Selection {
  modify: SelectionModifier;
}

function hasSelectionModify(
  selection: Selection
): selection is Selection & { modify: SelectionModifier } {
  return typeof (selection as SelectionWithModify).modify === "function";
}

function getOffsetFromRange(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

/**
 * Normalize the text content of a contenteditable element to plain text.
 */
export function normalizeContentEditableText(root: HTMLElement | null): string {
  if (!root) return "";

  const rawText = typeof root.innerText === "string" ? root.innerText : (root.textContent ?? "");
  const text = rawText.replace(/\u00a0/g, " ");

  if (text === "\n") {
    return "";
  }

  return text;
}

export function getSelectionRange(root: HTMLElement | null): SelectionRange | null {
  if (!root) return null;
  const selection: Selection | null = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }

  return {
    start: getOffsetFromRange(root, range.startContainer, range.startOffset),
    end: getOffsetFromRange(root, range.endContainer, range.endOffset),
  };
}

export function getCaretOffset(root: HTMLElement | null): number | null {
  const selection = getSelectionRange(root);
  return selection ? selection.start : null;
}

export function setSelectionRange(root: HTMLElement | null, range: SelectionRange): void {
  if (!root) return;
  const selection: Selection | null = window.getSelection();
  if (!selection) return;

  const text = normalizeContentEditableText(root);
  const max = text.length;
  const start = Math.max(0, Math.min(range.start, max));
  const end = Math.max(start, Math.min(range.end, max));

  if (!hasSelectionModify(selection)) {
    return;
  }

  selection.removeAllRanges();
  const seedRange = document.createRange();
  seedRange.selectNodeContents(root);
  seedRange.collapse(true);
  selection.addRange(seedRange);

  for (let i = 0; i < start; i += 1) {
    selection.modify("move", "forward", "character");
  }
  for (let i = 0; i < end - start; i += 1) {
    selection.modify("extend", "forward", "character");
  }
}

export function setCaretOffset(root: HTMLElement | null, offset: number): void {
  setSelectionRange(root, { start: offset, end: offset });
}
