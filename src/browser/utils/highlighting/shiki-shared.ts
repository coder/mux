/**
 * Shared constants and utilities for Shiki syntax highlighting
 * Used by both the main app and documentation theme
 */

// Shiki themes used throughout the application
export const SHIKI_DARK_THEME = "min-dark";
export const SHIKI_LIGHT_THEME = "min-light";

/**
 * Map language names to Shiki-compatible language IDs
 * Handles special cases where detected language differs from Shiki's name
 */
export function mapToShikiLang(detectedLang: string): string {
  const mapping: Record<string, string> = {
    text: "plaintext",
    sh: "bash",
    // Add more mappings as needed
  };
  return mapping[detectedLang] || detectedLang;
}

/**
 * Extract line contents from Shiki HTML output
 * Shiki wraps code in <pre><code>...</code></pre> with <span class="line">...</span> per line
 */
function isVisuallyEmptyShikiLine(lineHtml: string): boolean {
  // Shiki represents an empty line as something like:
  //   <span class="line"><span style="..."></span></span>
  // which is visually empty but non-empty as a string.
  //
  // We treat these as empty so callers don't render a phantom blank line.
  const textOnly = lineHtml
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, "")
    .trim();
  return textOnly === "";
}

export function extractShikiLines(html: string): string[] {
  const codeMatch = /<code[^>]*>(.*?)<\/code>/s.exec(html);
  if (!codeMatch) return [];

  const lines = codeMatch[1].split("\n").map((chunk) => {
    const start = chunk.indexOf('<span class="line">');
    if (start === -1) return "";

    const contentStart = start + '<span class="line">'.length;
    const end = chunk.lastIndexOf("</span>");

    const lineHtml = end > contentStart ? chunk.substring(contentStart, end) : "";
    return isVisuallyEmptyShikiLine(lineHtml) ? "" : lineHtml;
  });

  // Remove trailing empty lines (Shiki often adds one).
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}
