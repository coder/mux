/**
 * A safer JSON.stringify for diagnostics and accounting.
 *
 * mux persists some “binary-ish” payloads (notably screenshots) as base64 strings.
 * Those are useful for UI rendering, but they are *not* meaningful “text tokens” and
 * can explode:
 * - local token estimation (consumer breakdown)
 * - history truncation weighting
 * - debug_obj dumps
 *
 * This helper redacts known binary-ish fields while still producing a stable,
 * JSON-like string for tokenization and debugging.
 *
 * IMPORTANT: This must not be used for provider requests; it is only for
 * diagnostics/accounting.
 */
export function safeJsonStringify(value: unknown, options?: { space?: number }): string {
  const seen = new WeakSet<object>();

  const serialized = JSON.stringify(
    value,
    function replacer(this: unknown, key: string, val: unknown) {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) {
          return "[Circular]";
        }
        seen.add(val);
      }

      if (typeof val === "string") {
        // Redact data URLs (commonly image attachments).
        if (val.startsWith("data:")) {
          const commaIndex = val.indexOf(",");
          if (commaIndex === -1) {
            return "data:[malformed]";
          }

          const prefix = val.slice(0, commaIndex + 1);
          const payloadLength = val.length - commaIndex - 1;
          return `${prefix}[omitted len=${payloadLength}]`;
        }

        // Redact AI SDK media/image parts (base64 screenshot payloads).
        if (key === "data") {
          const parent = this as Record<string, unknown> | null;
          const parentType = parent?.type;
          if (parentType === "media" || parentType === "image") {
            const mediaType =
              (typeof parent?.mediaType === "string" && parent.mediaType) ||
              (typeof parent?.mimeType === "string" && parent.mimeType) ||
              "";
            const suffix = mediaType ? ` ${mediaType}` : "";
            return `[omitted image data len=${val.length}]${suffix}`;
          }
        }
      }

      return val;
    },
    options?.space
  );

  // JSON.stringify returns undefined for `undefined`/functions. For our use cases,
  // an empty string is a safe “0 tokens” fallback.
  return serialized ?? "";
}
