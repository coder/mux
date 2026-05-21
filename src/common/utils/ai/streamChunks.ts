/**
 * Field priority for AI SDK v5 text-delta payloads emitted by `fullStream`
 * parts and `streamText()` `onChunk` callbacks. Providers/SDKs normalize the
 * delta into one of these keys; `text` is preferred when present and the
 * older `delta` / `textDelta` aliases are fallbacks.
 */
export const TEXT_OUTPUT_DELTA_FIELDS = ["text", "delta", "textDelta"] as const;

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
