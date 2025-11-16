import MarkdownIt from "markdown-it";

/**
 * Extract the content under a heading titled "Mode: <mode>" (case-insensitive).
 * - Matches any heading level (#..######)
 * - Returns raw markdown content between this heading and the next heading
 *   of the same or higher level in the same document
 * - If multiple sections match, the first one wins
 * - The heading line itself is excluded from the returned content
 */
export function extractModeSection(markdown: string, mode: string): string | null {
  if (!markdown || !mode) return null;

  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const tokens = md.parse(markdown, {});
  const lines = markdown.split(/\r?\n/);
  const target = `mode: ${mode}`.toLowerCase();

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "heading_open") continue;

    const level = Number(t.tag?.replace(/^h/, "")) || 1;
    const inline = tokens[i + 1];
    if (inline?.type !== "inline") continue;

    const text = (inline.content || "").trim().toLowerCase();
    if (text !== target) continue;

    // Start content after the heading block ends
    const headingEndLine = inline.map?.[1] ?? t.map?.[1] ?? (t.map?.[0] ?? 0) + 1;

    // Find the next heading of same or higher level to bound the section
    let endLine = lines.length; // exclusive
    for (let j = i + 1; j < tokens.length; j++) {
      const tt = tokens[j];
      if (tt.type === "heading_open") {
        const nextLevel = Number(tt.tag?.replace(/^h/, "")) || 1;
        if (nextLevel <= level) {
          endLine = tt.map?.[0] ?? endLine;
          break;
        }
      }
    }

    const slice = lines.slice(headingEndLine, endLine).join("\n").trim();
    return slice.length > 0 ? slice : null;
  }

  return null;
}
