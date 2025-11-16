import MarkdownIt from "markdown-it";

type HeadingMatcher = (headingText: string, level: number) => boolean;

function extractSectionByHeading(
  markdown: string,
  headingMatcher: HeadingMatcher
): string | null {
  if (!markdown) return null;

  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const tokens = md.parse(markdown, {});
  const lines = markdown.split(/\r?\n/);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== "heading_open") continue;

    const level = Number(token.tag?.replace(/^h/, "")) || 1;
    const inline = tokens[i + 1];
    if (inline?.type !== "inline") continue;

    const headingText = (inline.content || "").trim();
    if (!headingMatcher(headingText, level)) continue;

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

/**
 * Extract the content under a heading titled "Mode: <mode>" (case-insensitive).
 */
export function extractModeSection(markdown: string, mode: string): string | null {
  if (!markdown || !mode) return null;

  const expectedHeading = `mode: ${mode}`.toLowerCase();
  return extractSectionByHeading(markdown, (headingText) => headingText.toLowerCase() === expectedHeading);
}

/**
 * Extract the first section whose heading matches "Model: <regex>" and whose regex matches
 * the provided model identifier. Matching is case-insensitive by default unless the regex
 * heading explicitly specifies flags via /pattern/flags syntax.
 */
export function extractModelSection(markdown: string, modelId: string): string | null {
  if (!markdown || !modelId) return null;

  const headingPattern = /^model:\s*(.+)$/i;

  const compileRegex = (pattern: string): RegExp | null => {
    const trimmed = pattern.trim();
    if (!trimmed) return null;

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

  return extractSectionByHeading(markdown, (headingText) => {
    const match = headingPattern.exec(headingText);
    if (!match) return false;
    const regex = compileRegex(match[1] ?? "");
    return Boolean(regex && regex.test(modelId));
  });
}
