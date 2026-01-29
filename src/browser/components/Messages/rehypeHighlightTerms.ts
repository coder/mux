import type { Root, Element, Text, Parent } from "hast";

export interface HighlightPattern {
  /** Regex to match text (should have 'g' flag for multiple matches) */
  match: RegExp;
  /** CSS class name to apply to matched text */
  className: string;
}

const SKIP_TAGS = new Set(["code", "pre", "script", "style"]);

type HighlightNode = Text | Element;

interface MatchInfo {
  start: number;
  end: number;
  className: string;
  text: string;
}

function collectMatches(text: string, patterns: HighlightPattern[]): MatchInfo[] {
  const matches: MatchInfo[] = [];

  for (const pattern of patterns) {
    const flags = pattern.match.flags.includes("g")
      ? pattern.match.flags
      : `${pattern.match.flags}g`;
    const regex = new RegExp(pattern.match.source, flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        className: pattern.className,
        text: match[0],
      });
    }
  }

  return matches;
}

function buildReplacements(text: string, matches: MatchInfo[]): HighlightNode[] | null {
  if (matches.length === 0) return null;

  const replacements: HighlightNode[] = [];
  let lastIndex = 0;

  matches.sort((a, b) => a.start - b.start);

  for (const match of matches) {
    if (match.start < lastIndex) continue;

    if (match.start > lastIndex) {
      replacements.push({ type: "text", value: text.slice(lastIndex, match.start) });
    }

    replacements.push({
      type: "element",
      tagName: "span",
      properties: { className: [match.className] },
      children: [{ type: "text", value: match.text }],
    });

    lastIndex = match.end;
  }

  if (lastIndex < text.length) {
    replacements.push({ type: "text", value: text.slice(lastIndex) });
  }

  return replacements;
}

/**
 * Rehype plugin that wraps matched text patterns in styled <span> elements.
 * Operates on the HTML AST after markdown parsing, preserving markdown structure.
 * Skips code/pre elements to avoid highlighting in code blocks.
 */
export function rehypeHighlightTerms(options: { patterns: HighlightPattern[] }) {
  const { patterns } = options;

  return (tree: Root) => {
    if (patterns.length === 0) return;

    const walk = (parent: Parent, inSkipTag: boolean) => {
      for (let i = 0; i < parent.children.length; i += 1) {
        const child = parent.children[i];

        if (child.type === "text") {
          if (inSkipTag) continue;

          const matches = collectMatches(child.value, patterns);
          const replacements = buildReplacements(child.value, matches);
          if (!replacements) continue;

          parent.children.splice(i, 1, ...replacements);
          i += replacements.length - 1;
          continue;
        }

        if (child.type === "element") {
          const nextSkipTag = inSkipTag || SKIP_TAGS.has(child.tagName);
          walk(child, nextSkipTag);
        }
      }
    };

    walk(tree, false);
  };
}
