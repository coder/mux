export type FileEol = "\n" | "\r\n";

/**
 * Normalize all newline styles to LF.
 *
 * This is intentionally conservative and scoped to file-edit tools where we want
 * to be resilient to Windows CRLF vs. model-generated LF mismatches.
 */
export function normalizeNewlinesToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Detect a file's newline style.
 *
 * We prefer CRLF if we see any CRLF sequences.
 */
export function detectFileEol(originalContent: string): FileEol {
  return originalContent.includes("\r\n") ? "\r\n" : "\n";
}

export function convertNewlines(text: string, eol: FileEol): string {
  return normalizeNewlinesToLF(text).replace(/\n/g, eol);
}
