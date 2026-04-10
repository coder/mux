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
