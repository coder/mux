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

/**
 * Extract the first section whose heading matches "Model: <regex>" and whose regex matches
 * the provided model identifier. Matching is case-insensitive by default unless the regex
 * heading explicitly specifies flags via /pattern/flags syntax.
 */
export function extractModelSection(markdown: string, modelId: string): string | null {
  if (!markdown || !modelId) return null;

  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const tokens = md.parse(markdown, {});
  const lines = markdown.split(/\r?\n/);
  const headingPattern = /^model:\s*(.+)$/i;

  const compileRegex = (pattern: string): RegExp | null => {
    const trimmed = pattern.trim();
    if (!trimmed) return null;

    // Allow optional /pattern/flags syntax; default to case-insensitive matching otherwise
    if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) {
      const lastSlash = trimmed.lastIndexOf("/");
      const source = trimmed.slice(1, lastSlash);
      const flags = trimmed.slice(lastSlash + 1);
      try {
        return new RegExp(source, flags || undefined);
      } catch {
        return null;
      }
    }

    try {
      return new RegExp(trimmed, "i");
    } catch {
      return null;
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== "heading_open") continue;

    const level = Number(token.tag?.replace(/^h/, "")) || 1;
    const inline = tokens[i + 1];
    if (inline?.type !== "inline") continue;

    const match = headingPattern.exec((inline.content || "").trim());
    if (!match) continue;

    const regex = compileRegex(match[1] ?? "");
    if (!regex) continue;
    if (!regex.test(modelId)) continue;

    const headingEndLine = inline.map?.[1] ?? token.map?.[1] ?? (token.map?.[0] ?? 0) + 1;

    let endLine = lines.length;
    for (let j = i + 1; j < tokens.length; j++) {
      const nextToken = tokens[j];
      if (nextToken.type === "heading_open") {
        const nextLevel = Number(nextToken.tag?.replace(/^h/, "")) || 1;
        if (nextLevel <= level) {
          endLine = nextToken.map?.[0] ?? endLine;
          break;
        }
      }
    }

    const slice = lines.slice(headingEndLine, endLine).join("\n").trim();
    return slice.length > 0 ? slice : null;
  }

  return null;
}
