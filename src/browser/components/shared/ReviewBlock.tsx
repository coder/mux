/**
 * ReviewBlock - Renders <review> tags as styled components
 *
 * Used in:
 * - UserMessage to display submitted reviews nicely
 * - ChatInput preview to show reviews before sending
 * - MarkdownComponents for assistant message context
 */

import React, { useMemo } from "react";
import { MessageSquare } from "lucide-react";
import { DiffRenderer } from "./DiffRenderer";

interface ReviewBlockProps {
  /** Raw content inside the <review> tags */
  content: string;
}

interface ParsedReview {
  filePath: string;
  lineRange: string;
  code: string;
  comment: string;
}

/**
 * Parse review format: Re path:lines\n```\ncode\n```\n> comment
 */
function parseReviewContent(content: string): ParsedReview {
  const trimmed = content.trim();
  const headerMatch = /^Re\s+([^:]+):(\S+)/.exec(trimmed);
  const codeMatch = /```\n?([\s\S]*?)```/.exec(trimmed);
  const commentMatch = /```[\s\S]*?```\s*\n>\s*(.+?)$/m.exec(trimmed);

  return {
    filePath: headerMatch?.[1] ?? "unknown",
    lineRange: headerMatch?.[2] ?? "",
    code: codeMatch?.[1]?.trim() ?? "",
    comment: commentMatch?.[1]?.trim() ?? "",
  };
}

/**
 * Styled review block component
 */
export const ReviewBlock: React.FC<ReviewBlockProps> = ({ content }) => {
  const parsed = useMemo(() => parseReviewContent(content), [content]);

  // Format code for diff display - add context markers if needed
  const diffContent = useMemo(() => {
    if (!parsed.code) return "";
    const lines = parsed.code.split("\n");
    const hasDiffMarkers = lines.some((l) => /^[+-\s]/.test(l));
    if (hasDiffMarkers) return parsed.code;
    return lines.map((l) => ` ${l}`).join("\n");
  }, [parsed.code]);

  return (
    <div className="my-2 overflow-hidden rounded border border-[var(--color-review-accent)]/30 bg-[var(--color-review-accent)]/5">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[var(--color-review-accent)]/20 bg-[var(--color-review-accent)]/10 px-3 py-1.5 text-xs">
        <MessageSquare className="size-3.5 text-[var(--color-review-accent)]" />
        <span className="font-medium text-[var(--color-review-accent)]">Review Note</span>
        <span className="text-muted">·</span>
        <span className="text-secondary font-mono">
          {parsed.filePath}:{parsed.lineRange}
        </span>
      </div>

      {/* Code snippet */}
      {parsed.code && (
        <div className="max-h-32 overflow-auto border-b border-[var(--color-review-accent)]/20 text-[11px]">
          <DiffRenderer
            content={diffContent}
            showLineNumbers={false}
            fontSize="11px"
            filePath={parsed.filePath}
          />
        </div>
      )}

      {/* Comment */}
      {parsed.comment && (
        <div className="px-3 py-2">
          <blockquote className="text-primary border-l-2 border-[var(--color-review-accent)] pl-2 text-sm italic">
            {parsed.comment}
          </blockquote>
        </div>
      )}
    </div>
  );
};

/**
 * Check if content contains review blocks
 */
export function hasReviewBlocks(content: string): boolean {
  return /<review>[\s\S]*?<\/review>/.test(content);
}

/**
 * Split content into segments of text and review blocks
 */
export interface ContentSegment {
  type: "text" | "review";
  content: string;
}

export function splitContentWithReviews(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const regex = /<review>([\s\S]*?)<\/review>/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(content)) !== null) {
    // Add text before the review block
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index);
      if (text.trim()) {
        segments.push({ type: "text", content: text });
      }
    }
    // Add the review block
    segments.push({ type: "review", content: match[1] });
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last review block
  if (lastIndex < content.length) {
    const text = content.slice(lastIndex);
    if (text.trim()) {
      segments.push({ type: "text", content: text });
    }
  }

  return segments;
}

/**
 * Render content with review blocks inline
 */
export const ContentWithReviews: React.FC<{ content: string; textClassName?: string }> = ({
  content,
  textClassName,
}) => {
  const segments = useMemo(() => splitContentWithReviews(content), [content]);

  if (segments.length === 0) {
    return null;
  }

  // If no review blocks, just return null to let caller render normally
  if (segments.length === 1 && segments[0].type === "text") {
    return null;
  }

  return (
    <>
      {segments.map((segment, idx) =>
        segment.type === "review" ? (
          <ReviewBlock key={idx} content={segment.content} />
        ) : (
          <pre key={idx} className={textClassName}>
            {segment.content}
          </pre>
        )
      )}
    </>
  );
};
