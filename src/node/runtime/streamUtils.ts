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
export interface StreamToStringOptions {
  timeoutMs?: number;
}

export async function streamToString(
  stream: ReadableStream<Uint8Array>,
  options?: StreamToStringOptions
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let result = "";
  const timeoutMs = options?.timeoutMs;
  const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : null;
  let timedOut = false;

  try {
    while (true) {
      if (deadline !== null) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          timedOut = true;
          break;
        }

        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let readResult: Awaited<ReturnType<typeof reader.read>> | "timeout";
        try {
          readResult = await Promise.race([
            reader.read(),
            new Promise<"timeout">((resolve) => {
              timeoutId = setTimeout(() => resolve("timeout"), remainingMs);
            }),
          ]);
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        }

        if (readResult === "timeout") {
          timedOut = true;
          break;
        }

        const { done, value } = readResult;
        if (done) break;
        result += decoder.decode(value, { stream: true });
        continue;
      }

      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }

    result += decoder.decode();
    return result;
  } finally {
    if (timedOut) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancel errors.
      }
    }
    reader.releaseLock();
  }
}
