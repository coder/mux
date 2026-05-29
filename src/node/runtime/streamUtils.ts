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

/** Convert a ReadableStream<Uint8Array> to one concatenated Uint8Array. */
export async function streamToUint8Array(
  stream: ReadableStream<Uint8Array>,
  maxBytes?: number
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      const nextLength = totalLength + value.length;
      if (maxBytes != null && nextLength > maxBytes) {
        throw new Error(`Stream exceeded ${maxBytes} byte limit`);
      }
      chunks.push(value);
      totalLength = nextLength;
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Stream may already be errored or canceled.
      }
    }
    reader.releaseLock();
  }

  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
