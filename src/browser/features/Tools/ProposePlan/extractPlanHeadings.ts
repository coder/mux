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

/**
 * Extract heading entries from a plan's markdown source.
 *
 * Supports ATX headings (`# Heading`, with optional trailing `#` markers), setext
 * headings (a text line followed by `===` or `---`), and raw HTML headings on
 * their own line (`<h2>...</h2>`). Skips lines inside fenced code blocks
 * (``` or ~~~) so example markdown inside code samples never shows up in the TOC.
 *
 * The output indices line up with what Streamdown / remark-gfm will render so
 * `renderIndex` can be used to locate the matching DOM element by order.
 */
export function extractPlanHeadings(markdown: string): PlanHeading[] {
  if (!markdown) {
    return [];
  }

  const lines = markdown.split("\n");
  const headings: PlanHeading[] = [];

  let inFence = false;
  let fenceChar: "`" | "~" | null = null;
  let fenceLength = 0;
  let htmlBlockState: HtmlBlockState | null = null;
  let renderIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const structuralLine = stripAtxContainerPrefixes(line);
    const structuralTrimmed = structuralLine.trim();
    const blockquoteLine = stripBlockquotePrefixes(line);
    const blockquoteTrimmed = blockquoteLine.trim();

    // Track fenced code blocks. CommonMark allows up to three leading spaces
    // before a fence; four spaces are indented code, not a fence. We also strip
    // container markers so quoted/list-contained fences suppress headings inside
    // them the same way the markdown renderer does.
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(structuralLine);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const ch = marker[0] as "`" | "~";
      const len = marker.length;
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
        fenceLength = len;
      } else if (ch === fenceChar && len >= fenceLength && /^[`~]+\s*$/.test(structuralTrimmed)) {
        inFence = false;
        fenceChar = null;
        fenceLength = 0;
      }
      continue;
    }

    if (inFence) {
      continue;
    }

    if (htmlBlockState && !htmlBlockState.countsNestedHeadings) {
      if (htmlBlockTerminates(htmlBlockState, structuralTrimmed)) {
        htmlBlockState = null;
      }
      continue;
    }

    const htmlCandidateLine: string | null = htmlBlockState
      ? structuralTrimmed
      : getHtmlCandidateLine(structuralLine);

    const htmlBlockStart: HtmlBlockState | null = htmlCandidateLine
      ? getHtmlBlockStart(htmlCandidateLine)
      : null;
    if (htmlBlockStart && !htmlBlockStart.countsNestedHeadings) {
      if (!htmlBlockTerminates(htmlBlockStart, structuralTrimmed)) {
        htmlBlockState = htmlBlockStart;
      }
      continue;
    }

    if (htmlCandidateLine != null) {
      // Raw HTML h1-h6 tags render into the same heading NodeList even when they
      // are nested in another HTML block or share a line with other HTML/text.
      for (const htmlHeading of extractCompleteHtmlHeadings(htmlCandidateLine)) {
        if (htmlHeading.text) {
          headings.push({ renderIndex, level: htmlHeading.level, text: htmlHeading.text });
        }
        // Empty raw HTML headings still render as hN elements, so they consume
        // an index even when they do not produce a useful TOC entry.
        renderIndex += 1;
      }

      const multilineHtmlHeadingLevel = getMultilineHtmlHeadingLevel(htmlCandidateLine);
      if (multilineHtmlHeadingLevel != null) {
        // Multiline raw HTML headings render as hN elements, but collecting their
        // display text would require a full HTML parse. Count the DOM node so
        // later markdown headings keep correct renderIndex alignment.
        renderIndex += 1;
        htmlBlockState ??= {
          closingPattern: new RegExp(`</h${multilineHtmlHeadingLevel}>`, "i"),
          terminatesOnBlank: false,
          countsNestedHeadings: false,
        };
        continue;
      }
    }

    if (htmlBlockState) {
      if (htmlBlockTerminates(htmlBlockState, structuralTrimmed)) {
        htmlBlockState = null;
      }
      continue;
    }

    if (htmlBlockStart) {
      if (!htmlBlockTerminates(htmlBlockStart, structuralTrimmed)) {
        htmlBlockState = htmlBlockStart;
      }
      continue;
    }

    // ATX heading: up to three leading spaces, then 1-6 `#`s. Four leading
    // spaces are indented code, so matching them would drift from markdown's
    // rendered h1..h6 order.
    const atxMatch = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(structuralLine);
    if (atxMatch) {
      const level = atxMatch[1].length;
      const rawText = (atxMatch[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "");
      const text = stripMarkdownFormatting(rawText);
      if (text) {
        headings.push({ renderIndex, level, text });
      }
      // Empty headings still render as hN elements, so they must consume a
      // renderIndex even though they are not useful TOC entries.
      renderIndex += 1;
      continue;
    }

    // Setext heading: text line followed by === (h1) or --- (h2). Skip blank
    // text lines and list/fence/thematic-break starters so we don't invent a
    // heading where markdown renders a list item or horizontal rule instead.
    // Preserve underline indentation: a 4-space-indented underline is code, not
    // a heading marker, so trimming it would create phantom headings.
    if (
      i + 1 < lines.length &&
      /^ {0,3}\S/.test(blockquoteLine) &&
      blockquoteTrimmed.length > 0 &&
      !/^[#>\-*+`~<]/.test(blockquoteTrimmed) &&
      !/^\d{1,9}[.)][ \t]/.test(blockquoteTrimmed)
    ) {
      const nextSetextLine = stripBlockquotePrefixes(lines[i + 1]);
      if (/^ {0,3}=+[ \t]*$/.test(nextSetextLine)) {
        const text = stripMarkdownFormatting(blockquoteTrimmed);
        if (text) {
          headings.push({ renderIndex, level: 1, text });
          renderIndex += 1;
          i += 1; // consume the underline
          continue;
        }
      }
      if (/^ {0,3}-{2,}[ \t]*$/.test(nextSetextLine)) {
        const text = stripMarkdownFormatting(blockquoteTrimmed);
        if (text) {
          headings.push({ renderIndex, level: 2, text });
          renderIndex += 1;
          i += 1; // consume the underline
          continue;
        }
      }
    }
  }

  return headings;
}

interface HtmlBlockState {
  closingPattern?: RegExp;
  terminatesOnBlank: boolean;
  countsNestedHeadings: boolean;
}

const HTML_BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_BLOCK_TAG_PATTERN = new RegExp(`^</?(?:${HTML_BLOCK_TAGS})(?=[\\s>/])`, "i");

interface CompleteHtmlHeading {
  level: number;
  text: string;
}

function extractCompleteHtmlHeadings(line: string): CompleteHtmlHeading[] {
  const headings: CompleteHtmlHeading[] = [];
  const headingPattern = /<h([1-6])\b[^>]*>(.*?)<\/h\1>/gi;
  let match = headingPattern.exec(line);
  while (match) {
    headings.push({
      level: parseInt(match[1], 10),
      text: stripMarkdownFormatting(match[2].replace(/<[^>]+>/g, "")),
    });
    match = headingPattern.exec(line);
  }
  return headings;
}

function getMultilineHtmlHeadingLevel(line: string): string | null {
  const match = /<h([1-6])\b[^>]*>(?!.*<\/h\1>)/i.exec(line);
  return match ? match[1] : null;
}

function getHtmlCandidateLine(line: string): string | null {
  const match = /^ {0,3}(?! )(.*)$/.exec(line);
  return match ? match[1].trim() : null;
}

function getHtmlBlockStart(trimmedLine: string): HtmlBlockState | null {
  if (/^<(?:script|pre|style)(?=[\s>])/i.test(trimmedLine)) {
    return {
      closingPattern: /<\/(?:script|pre|style)>/i,
      terminatesOnBlank: false,
      countsNestedHeadings: false,
    };
  }

  if (trimmedLine.startsWith("<!--")) {
    return { closingPattern: /-->/, terminatesOnBlank: false, countsNestedHeadings: false };
  }
  if (trimmedLine.startsWith("<?")) {
    return { closingPattern: /\?>/, terminatesOnBlank: false, countsNestedHeadings: false };
  }
  if (/^<![A-Z]/.test(trimmedLine)) {
    return { closingPattern: />/, terminatesOnBlank: false, countsNestedHeadings: false };
  }
  if (trimmedLine.startsWith("<![CDATA[")) {
    return { closingPattern: /\]\]>/, terminatesOnBlank: false, countsNestedHeadings: false };
  }

  if (HTML_BLOCK_TAG_PATTERN.test(trimmedLine)) {
    return { terminatesOnBlank: true, countsNestedHeadings: true };
  }

  // CommonMark also treats a complete open/closing HTML tag on its own line as
  // an HTML block. Raw h1-h6 lines are handled above so they still count toward
  // renderIndex.
  if (/^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>]*)?>\s*$/.test(trimmedLine)) {
    return { terminatesOnBlank: true, countsNestedHeadings: true };
  }

  return null;
}

function htmlBlockTerminates(state: HtmlBlockState, trimmedLine: string): boolean {
  if (state.closingPattern) {
    return state.closingPattern.test(trimmedLine);
  }
  return state.terminatesOnBlank && trimmedLine.length === 0;
}

function stripAtxContainerPrefixes(line: string): string {
  let remaining = line;
  let changed = true;
  while (changed) {
    changed = false;

    const blockquoteMatch = /^ {0,3}>[ \t]?/.exec(remaining);
    if (blockquoteMatch) {
      remaining = remaining.slice(blockquoteMatch[0].length);
      changed = true;
      continue;
    }

    const unorderedListMatch = /^ {0,3}[-+*][ \t]+/.exec(remaining);
    if (unorderedListMatch) {
      remaining = remaining.slice(unorderedListMatch[0].length);
      changed = true;
      continue;
    }

    const orderedListMatch = /^ {0,3}\d{1,9}[.)][ \t]+/.exec(remaining);
    if (orderedListMatch) {
      remaining = remaining.slice(orderedListMatch[0].length);
      changed = true;
    }
  }
  return remaining;
}

function stripBlockquotePrefixes(line: string): string {
  let remaining = line;
  while (true) {
    const blockquoteMatch = /^ {0,3}>[ \t]?/.exec(remaining);
    if (!blockquoteMatch) {
      return remaining;
    }
    remaining = remaining.slice(blockquoteMatch[0].length);
  }
}

/**
 * Lightweight inline-formatting stripper used only for TOC display text. Not a
 * full markdown parser — we trade exhaustive correctness for predictable output
 * on the small subset of inline syntax that shows up in heading lines.
 */
function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, "$1") // unescape \*  \[ etc.
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
