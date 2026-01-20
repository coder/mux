import React, { useMemo } from "react";
import { Streamdown } from "streamdown";
import type { Pluggable } from "unified";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { harden } from "rehype-harden";
import { normalizeMarkdown } from "./MarkdownStyles";
import { isStorybook } from "@/browser/utils/storybook";
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
}

// Plugin arrays are defined at module scope to maintain stable references.
// Streamdown treats new array references as changes requiring full re-parse.
const REMARK_PLUGINS_BASE: Pluggable[] = [[remarkGfm, {}]];

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

const REHYPE_PLUGINS_BASE: Pluggable[] = [
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
];

const markdownCoreMathImport = isStorybook()
  ? import("./MarkdownCoreMath").then((m) => ({ default: m.MarkdownCoreMath }))
  : null;

const LazyMarkdownCoreMath = React.lazy(
  () =>
    markdownCoreMathImport ??
    import("./MarkdownCoreMath").then((m) => ({ default: m.MarkdownCoreMath }))
);

function hasMathSyntax(content: string): boolean {
  // Prefer low-false-positive matches (single-$ math is disabled in remark-math config).
  return /\$\$|\\\(|\\\[|\\begin\{/.test(content);
}

/**
 * Core markdown rendering component that handles all markdown processing.
 * This is the single source of truth for markdown configuration.
 *
 * Memoized to prevent expensive re-parsing when content hasn't changed.
 */
export const MarkdownCore = React.memo<MarkdownCoreProps>(
  ({ content, children, parseIncompleteMarkdown = false }) => {
    const normalizedContent = useMemo(() => normalizeMarkdown(content), [content]);
    const shouldRenderMath = useMemo(() => hasMathSyntax(content), [content]);

    const base = (
      <>
        <Streamdown
          components={markdownComponents}
          remarkPlugins={REMARK_PLUGINS_BASE}
          rehypePlugins={REHYPE_PLUGINS_BASE}
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

    if (!shouldRenderMath) {
      return base;
    }

    return (
      <React.Suspense fallback={base}>
        <LazyMarkdownCoreMath content={content} parseIncompleteMarkdown={parseIncompleteMarkdown}>
          {children}
        </LazyMarkdownCoreMath>
      </React.Suspense>
    );
  }
);

MarkdownCore.displayName = "MarkdownCore";
