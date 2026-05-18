export function extractChunkDeltaText(
  chunk: Record<string, unknown>,
  fieldPriority: readonly string[]
): string {
  for (const field of fieldPriority) {
    const value = chunk[field];
    if (typeof value === "string") {
      return value;
    }
  }

  return "";
}
