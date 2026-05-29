// Normalize markdown to remove excess blank lines and normalize newline characters.
//
// We normalize to LF because some upstream sources (including certain model/SDK
// combinations) can emit non-LF line separators (CRLF, CR, or unicode line
// separators). Without normalization, those separators may get ignored by the
// markdown pipeline (including remark-breaks), which can cause lines to run
// together in rendered output.
export function normalizeMarkdown(content: string): string {
  // First, normalize common newline variants to LF.
  const normalizedNewlines = content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // Unicode line/paragraph separators (and NEL) occasionally show up in streamed text.
    .replace(/[\u2028\u2029\u0085]/g, "\n");

  // Then, replace 3+ consecutive newlines with exactly 2 newlines.
  return normalizedNewlines.replace(/\n{3,}/g, "\n\n");
}

// Some models emit terse reasoning traces that include markdown-y section headers like
// `**Deciding on status updates**`, but occasionally omit a leading newline. That can
// cause the header to run into the previous sentence (e.g. `...!**Deciding...**\n\n`).
//
// This is a small, reasoning-only heuristic fixup applied in ReasoningMessage.
export function normalizeReasoningMarkdown(content: string): string {
  // Insert a newline before bold section headers when they appear immediately after
  // sentence-ending punctuation and are followed by a blank line.
  return content.replace(/([.!?])([ \t]*)(\*\*[^*\n]{2,}\*\*(?::)?[ \t]*\n\n)/g, "$1\n$3");
}
