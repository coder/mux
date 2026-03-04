import assert from "@/common/utils/assert";

/**
 * Extract the first line of text, truncated to maxLen characters.
 * DevTools cards use this for a compact collapsed-state preview.
 */
export function truncateToFirstLine(text: string, maxLen: number): string {
  assert(typeof text === "string", "truncateToFirstLine: text must be a string");
  assert(
    Number.isInteger(maxLen) && maxLen >= 0,
    "truncateToFirstLine: maxLen must be a non-negative integer"
  );

  const firstLine = text.split("\n")[0] ?? "";
  if (firstLine.length <= maxLen) {
    return firstLine;
  }

  return `${firstLine.slice(0, maxLen)}…`;
}
