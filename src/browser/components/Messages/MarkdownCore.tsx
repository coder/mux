import React, { useMemo } from "react";
import { Streamdown } from "streamdown";
import type { Pluggable } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import { harden } from "rehype-harden";
import "katex/dist/katex.min.css";
import { normalizeMarkdown } from "./MarkdownStyles";
import { markdownComponents } from "./MarkdownComponents";

interface MarkdownCoreProps {
  content: string;
  children?: React.ReactNode; // For cursor or other additions
}

// Plugin arrays are defined at module scope to maintain stable references.
// Streamdown treats new array references as changes requiring full re-parse.
const REMARK_PLUGINS: Pluggable[] = [
  [remarkGfm, {}],
  [remarkMath, { singleDollarTextMath: false }],
];

const REHYPE_PLUGINS: Pluggable[] = [
  rehypeRaw, // Parse HTML elements first
  [
    harden, // Sanitize after parsing raw HTML to prevent XSS
    {
      allowedImagePrefixes: ["*"],
      allowedLinkPrefixes: ["*"],
      defaultOrigin: undefined,
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
export const MarkdownCore = React.memo<MarkdownCoreProps>(({ content, children }) => {
  // Memoize the normalized content to avoid recalculating on every render
  const normalizedContent = useMemo(() => normalizeMarkdown(content), [content]);

  return (
    <>
      <Streamdown
        components={markdownComponents}
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        parseIncompleteMarkdown={true}
        className="space-y-2" // Reduce from default space-y-4 (16px) to space-y-2 (8px)
        controls={{ table: false, code: true, mermaid: true }} // Disable table copy/download, keep code/mermaid controls
      >
        {normalizedContent}
      </Streamdown>
      {children}
    </>
  );
});

MarkdownCore.displayName = "MarkdownCore";
