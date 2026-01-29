import React from "react";
import { MarkdownCore } from "./MarkdownCore";
import { cn } from "@/common/lib/utils";
import type { HighlightPattern } from "./rehypeHighlightTerms";

interface MarkdownRendererProps {
  content: string;
  className?: string;
  style?: React.CSSProperties;
  /**
   * Preserve single newlines as line breaks (like GitHub-flavored markdown).
   * When true, single newlines in text become <br> elements instead of being
   * collapsed to spaces. Useful for user-authored content where newlines
   * are intentional. Default: false.
   */
  preserveLineBreaks?: boolean;
  /**
   * Optional text patterns to highlight with CSS classes.
   * Used for hash skill mentions like #react-effects.
   */
  highlightTerms?: HighlightPattern[];
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  className,
  style,
  preserveLineBreaks,
  highlightTerms,
}) => {
  return (
    <div className={cn("markdown-content", className)} style={style}>
      <MarkdownCore
        content={content}
        preserveLineBreaks={preserveLineBreaks}
        highlightTerms={highlightTerms}
      />
    </div>
  );
};

// For plan-specific styling
export const PlanMarkdownContainer: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => {
  return (
    <div
      className={cn("markdown-content", className)}
      style={{
        // Plan-specific overrides
        // @ts-expect-error CSS custom property
        "--blockquote-color": "var(--color-plan-mode)",
        "--code-color": "var(--color-plan-mode-hover)",
      }}
    >
      {children}
    </div>
  );
};
