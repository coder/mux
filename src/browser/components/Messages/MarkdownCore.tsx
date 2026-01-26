import React, { useMemo } from "react";
import { Streamdown } from "streamdown";
import type { Pluggable } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { harden } from "rehype-harden";
import "katex/dist/katex.min.css";
import { normalizeMarkdown } from "./MarkdownStyles";
import { markdownComponents } from "./MarkdownComponents";

interface MarkdownCoreProps {
  content: string;
  children?: React.ReactNode; // For cursor or other additions
  /**
   * Enable incomplete markdown parsing for streaming content.
   * When true, the remend library will attempt to "repair" unclosed markdown
   * syntax (e.g., adding closing ** for bold). This is useful during streaming
   * but can cause bugs with content like $__variable (adds trailing __).
   * Default: false for completed content, true during streaming.
   */
  parseIncompleteMarkdown?: boolean;
  /**
   * Preserve single newlines as line breaks (like GitHub-flavored markdown).
   * When true, single newlines in text become <br> elements instead of being
   * collapsed to spaces. Useful for user-authored content where newlines
   * are intentional. Default: false.
   */
  preserveLineBreaks?: boolean;
}

// Plugin arrays are defined at module scope to maintain stable references.
// Streamdown treats new array references as changes requiring full re-parse.
const REMARK_PLUGINS: Pluggable[] = [
  [remarkGfm, {}],
  [remarkMath, { singleDollarTextMath: false }],
];

// Same as above, but with remarkBreaks to preserve single newlines as <br>.
// Used for user-authored content where newlines are intentional (e.g., user messages).
const REMARK_PLUGINS_WITH_BREAKS: Pluggable[] = [
  [remarkGfm, {}],
  remarkBreaks,
  [remarkMath, { singleDollarTextMath: false }],
];

// Schema for rehype-sanitize that allows safe HTML elements.
// Extends the default schema to support KaTeX math and collapsible sections.
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    // KaTeX MathML elements
    "math",
    "mrow",
    "mi",
    "mo",
    "mn",
    "msup",
    "msub",
    "mfrac",
    "munder",
    "mover",
    "mtable",
    "mtr",
    "mtd",
    "mspace",
    "mtext",
    "semantics",
    "annotation",
    "munderover",
    "msqrt",
    "mroot",
    "mpadded",
    "mphantom",
    "menclose",
    // Collapsible sections (GitHub-style)
    "details",
    "summary",
  ],
  attributes: {
    ...defaultSchema.attributes,
    // KaTeX uses style for coloring and positioning
    span: [...(defaultSchema.attributes?.span ?? []), "style"],
    // MathML elements need various attributes
    math: ["xmlns", "display"],
    annotation: ["encoding"],
    // Allow class on all elements for styling
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "class"],
  },
};

const REHYPE_PLUGINS: Pluggable[] = [
  rehypeRaw, // Parse HTML elements first
  [rehypeSanitize, sanitizeSchema], // Sanitize HTML to prevent XSS (strips dangerous elements/attributes)
  [
    harden, // Additional URL filtering for links and images
    {
      // SECURITY: Treat markdown content as untrusted. We rely on rehype-harden to
      // block dangerous URL schemes (e.g. javascript:, file:, vbscript:, data: in
      // links). Data images are allowed explicitly below.
      allowedImagePrefixes: ["*", "/"],
      allowedLinkPrefixes: ["*"],
      // rehype-harden requires a defaultOrigin when any allowlist is provided.
      // We use a stable placeholder origin so relative URLs can be resolved.
      defaultOrigin: "https://mux.invalid",
      allowDataImages: true,
    },
  ],
  [rehypeKatex, { errorColor: "var(--color-muted-foreground)" }], // Render math
];

/**
 * Core markdown rendering component that handles all markdown processing.
 * This is the single source of truth for markdown configuration.
 *
 * Memoized to prevent expensive re-parsing when content hasn't changed.
 */
export const MarkdownCore = React.memo<MarkdownCoreProps>(
  ({ content, children, parseIncompleteMarkdown = false, preserveLineBreaks = false }) => {
    // Memoize the normalized content to avoid recalculating on every render
    const normalizedContent = useMemo(() => normalizeMarkdown(content), [content]);

    return (
      <>
        <Streamdown
          components={markdownComponents}
          remarkPlugins={preserveLineBreaks ? REMARK_PLUGINS_WITH_BREAKS : REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          parseIncompleteMarkdown={parseIncompleteMarkdown}
          // Use "static" mode for completed content to bypass useTransition() deferral.
          // After ORPC migration, async event boundaries let React deprioritize transitions indefinitely.
          mode={parseIncompleteMarkdown ? "streaming" : "static"}
          className="space-y-2" // Reduce from default space-y-4 (16px) to space-y-2 (8px)
          controls={{ table: false, code: true, mermaid: true }} // Disable table copy/download, keep code/mermaid controls
        >
          {normalizedContent}
        </Streamdown>
        {children}
      </>
    );
  }
);

MarkdownCore.displayName = "MarkdownCore";
