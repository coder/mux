/**
 * Stream and shell utilities shared across runtime implementations
 */

/**
 * Shell-escape helper for bash commands.
 * Uses single-quote wrapping with proper escaping for embedded quotes.
 * Reused across SSH and Docker runtime operations.
 */
export const shescape = {
  quote(value: unknown): string {
    const s = String(value);
    if (s.length === 0) return "''";
    // Use POSIX-safe pattern to embed single quotes within single-quoted strings
    return "'" + s.replace(/'/g, "'\"'\"'") + "'";
  },
};

/**
 * Convert a ReadableStream to a string, capping accumulation at `maxBytes` raw bytes.
 *
 * Once the cap is reached, remaining chunks are read and DISCARDED rather than
 * buffered: draining keeps the child process's pipe flowing (no backpressure
 * stall) and preserves its natural exit code, while memory stays bounded.
 * Callers that need a duration bound must pair this with an exec timeout.
 */
export async function streamToStringCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<string> {
  if (!(Number.isFinite(maxBytes) && maxBytes >= 0)) {
    throw new Error(
      `streamToStringCapped: maxBytes must be a non-negative number, got ${maxBytes}`
    );
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  // Array-join instead of += for the same rope-avoidance reason as streamToString.
  const chunks: string[] = [];
  let collectedBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (collectedBytes >= maxBytes) {
        // Cap reached: drain without accumulating.
        truncated = truncated || value.byteLength > 0;
        continue;
      }
      const remaining = maxBytes - collectedBytes;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      truncated = truncated || slice.byteLength < value.byteLength;
      collectedBytes += slice.byteLength;
      chunks.push(decoder.decode(slice, { stream: true }));
    }
    // Only flush the decoder when the stream ended naturally under the cap.
    // When truncated, the cap may have split a multi-byte code point; flushing
    // would emit U+FFFD instead of a clean prefix, so drop the partial bytes.
    if (!truncated) {
      const tail = decoder.decode();
      if (tail) chunks.push(tail);
    }
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

/**
 * Convert a ReadableStream to a string.
 * Used by SSH and Docker runtimes for capturing command output.
 */
export async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  // Collect decoded chunks into an array and join at the end.
  // Using += would build a deep V8 ConsString rope; subsequent regex/indexOf
  // on that rope dereferences one pointer per character, causing O(n²)-class
  // hangs on large newline-free payloads (e.g. minified CSS from web_fetch).
  const chunks: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    // Final flush
    const tail = decoder.decode();
    if (tail) chunks.push(tail);
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}
