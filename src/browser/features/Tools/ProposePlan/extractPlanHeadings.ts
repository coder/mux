import { rawHtmlUsesOnlyAllowedTags } from "@/browser/features/Messages/MarkdownCore";
import MarkdownIt from "markdown-it";

/**
 * A heading entry extracted from a plan's markdown source.
 *
 * `renderIndex` is the position of this heading among ALL h1..h6 elements
 * Streamdown will render for the same content. We use it to look up the matching
 * DOM node via `container.querySelectorAll("h1,h2,h3,h4,h5,h6")[renderIndex]`.
 * Keeping the index aligned to the rendered DOM (rather than slug IDs) avoids
 * mutating the shared markdown rehype pipeline just for plan TOC scrolling.
 */
export interface PlanHeading {
  renderIndex: number;
  /** 1-6, matching the rendered hN tag. */
  level: number;
  /** Plain text (markdown formatting stripped) shown in the TOC. */
  text: string;
}

interface HtmlHeading {
  level: number;
  text: string;
}

const markdownParser = new MarkdownIt({ html: true, linkify: false, typographer: false });
const HTML_HEADING_PATTERN = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
const NON_RENDERED_HTML_BLOCK_PATTERN =
  /<!--([\s\S]*?)(?:-->|$)|<\?(?:[\s\S]*?)(?:\?>|$)|<!\[CDATA\[(?:[\s\S]*?)(?:\]\]>|$)|<![A-Z][\s\S]*?(?:>|$)|<(?:script|pre|style)(?=[\s>]|$)[\s\S]*?(?:<\/(?:script|pre|style)\s*>|$)/gi;

/**
 * Extract heading entries from a plan's markdown source.
 *
 * Markdown block structure is delegated to markdown-it so ATX, setext,
 * blockquote/list containers, indented code, and fenced code stay aligned with
 * the rendered markdown. Raw HTML h1-h6 tags are counted separately because the
 * renderer allows raw HTML and those tags also appear in the heading NodeList.
 */
export function extractPlanHeadings(markdown: string): PlanHeading[] {
  if (!markdown) {
    return [];
  }

  const tokens = markdownParser.parse(markdown, {});
  const headings: PlanHeading[] = [];
  let renderIndex = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === "heading_open") {
      const level = parseHeadingLevel(token.tag);
      const inline = tokens[i + 1];
      const text = stripMarkdownFormatting(inline?.type === "inline" ? inline.content : "");
      if (text) {
        headings.push({ renderIndex, level, text });
      }
      // Empty markdown headings still render hN elements, so they consume an
      // index even when they do not produce a useful TOC entry.
      renderIndex += 1;
      continue;
    }

    if (token.type === "html_block" || token.type === "html_inline") {
      for (const htmlHeading of extractHtmlHeadings(token.content)) {
        if (htmlHeading.text) {
          headings.push({ renderIndex, level: htmlHeading.level, text: htmlHeading.text });
        }
        // Empty raw HTML headings still render hN elements, so they consume an
        // index even when they do not produce a useful TOC entry.
        renderIndex += 1;
      }
    }
  }

  return headings;
}

function parseHeadingLevel(tag: string): number {
  const level = Number(tag.replace(/^h/i, ""));
  return level >= 1 && level <= 6 ? level : 1;
}

function extractHtmlHeadings(html: string): HtmlHeading[] {
  if (!rawHtmlUsesOnlyAllowedTags(html)) {
    return [];
  }

  const renderedHtml = html.replace(NON_RENDERED_HTML_BLOCK_PATTERN, "");
  const headings: HtmlHeading[] = [];
  HTML_HEADING_PATTERN.lastIndex = 0;

  let match = HTML_HEADING_PATTERN.exec(renderedHtml);
  while (match) {
    headings.push({
      level: parseInt(match[1], 10),
      text: stripMarkdownFormatting(match[2].replace(/<[^>]+>/g, "")),
    });
    match = HTML_HEADING_PATTERN.exec(renderedHtml);
  }

  return headings;
}

/**
 * Lightweight inline-formatting stripper used only for TOC display text. Not a
 * full markdown parser — markdown-it has already handled block structure; this
 * only normalizes raw HTML heading text and a few markdown-ish inline remnants.
 */
function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/\\([\\`*_{}\x5B\]()#+\-.!|~])/g, "$1") // unescape \*  \[ etc.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // ![alt](src)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [label](href)
    .replace(/`([^`]+)`/g, "$1") // `code`
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/__([^_]+)__/g, "$1") // __bold__
    .replace(/\*([^*]+)\*/g, "$1") // *italic*
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1") // _italic_ (avoid mid-word matches)
    .replace(/~~([^~]+)~~/g, "$1") // ~~strike~~
    .replace(/<[^>]+>/g, "") // stray inline HTML tags
    .replace(/\s+/g, " ")
    .trim();
}
