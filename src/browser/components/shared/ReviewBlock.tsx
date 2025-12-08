/**
 * ReviewBlock - Renders <review> tags as styled components
 *
 * Used in:
 * - UserMessage to display submitted reviews nicely
 * - ChatInput preview to show reviews before sending
 * - MarkdownComponents for assistant message context
 */

import React, { useMemo, useState, useCallback, useRef } from "react";
import { MessageSquare, X, Pencil, Check } from "lucide-react";
import { DiffRenderer } from "./DiffRenderer";
import { Button } from "../ui/button";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";

interface ReviewBlockProps {
  /** Raw content inside the <review> tags */
  content: string;
  /** Optional callback to remove the review (shows X button in header) */
  onRemove?: () => void;
  /** Optional callback to edit the comment - enables edit mode when provided */
  onEditComment?: (newComment: string) => void;
}

interface ReviewBlockFromDataProps {
  /** Structured review data (no parsing needed) */
  data: ReviewNoteDataForDisplay;
  /** Optional callback to remove the review */
  onRemove?: () => void;
  /** Optional callback to edit the comment */
  onEditComment?: (newComment: string) => void;
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
export const ReviewBlock: React.FC<ReviewBlockProps> = ({ content, onRemove, onEditComment }) => {
  const parsed = useMemo(() => parseReviewContent(content), [content]);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(parsed.comment);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Format code for diff display - add context markers if needed
  const diffContent = useMemo(() => {
    if (!parsed.code) return "";
    const lines = parsed.code.split("\n");
    const hasDiffMarkers = lines.some((l) => /^[+-\s]/.test(l));
    if (hasDiffMarkers) return parsed.code;
    return lines.map((l) => ` ${l}`).join("\n");
  }, [parsed.code]);

  const handleStartEdit = useCallback(() => {
    setEditValue(parsed.comment);
    setIsEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [parsed.comment]);

  const handleSaveEdit = useCallback(() => {
    if (onEditComment && editValue.trim() !== parsed.comment) {
      onEditComment(editValue.trim());
    }
    setIsEditing(false);
  }, [editValue, parsed.comment, onEditComment]);

  const handleCancelEdit = useCallback(() => {
    setEditValue(parsed.comment);
    setIsEditing(false);
  }, [parsed.comment]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSaveEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleCancelEdit();
      }
    },
    [handleSaveEdit, handleCancelEdit]
  );

  return (
    <div className="overflow-hidden rounded border border-[var(--color-review-accent)]/30 bg-[var(--color-review-accent)]/5">
      {/* Header */}
      <div className="flex items-center gap-1.5 border-b border-[var(--color-review-accent)]/20 bg-[var(--color-review-accent)]/10 px-2 py-1 text-xs">
        <MessageSquare className="size-3 shrink-0 text-[var(--color-review-accent)]" />
        <span className="text-primary min-w-0 flex-1 truncate font-mono">
          {parsed.filePath}:{parsed.lineRange}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-muted hover:text-error -mr-0.5 flex shrink-0 items-center justify-center rounded p-0.5 transition-colors"
            title="Remove from message"
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      {/* Code snippet */}
      {parsed.code && (
        <div className="max-h-64 overflow-auto border-b border-[var(--color-review-accent)]/20 text-[11px]">
          <DiffRenderer
            content={diffContent}
            showLineNumbers={false}
            fontSize="11px"
            filePath={parsed.filePath}
            className="rounded-none"
          />
        </div>
      )}

      {/* Comment - editable when onEditComment provided */}
      {(parsed.comment || onEditComment) && (
        <div className="group/comment px-2 py-1">
          {isEditing ? (
            <div className="space-y-1">
              <textarea
                ref={textareaRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                className="text-primary w-full resize-none rounded border border-[var(--color-review-accent)]/40 bg-[var(--color-review-accent)]/10 px-1.5 py-1 text-xs focus:border-[var(--color-review-accent)]/60 focus:outline-none"
                rows={2}
                placeholder="Your comment..."
              />
              <div className="flex items-center justify-end gap-1">
                <span className="text-muted mr-1 text-[10px]">⌘Enter save, Esc cancel</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={handleCancelEdit}
                >
                  <X className="mr-0.5 size-2.5" />
                  Cancel
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={handleSaveEdit}
                >
                  <Check className="mr-0.5 size-2.5" />
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-1">
              <blockquote className="text-primary flex-1 border-l-2 border-[var(--color-review-accent)] pl-1.5 text-xs italic">
                {parsed.comment || <span className="text-muted">No comment</span>}
              </blockquote>
              {onEditComment && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5 shrink-0 opacity-0 transition-opacity group-hover/comment:opacity-100 [&_svg]:size-3"
                  onClick={handleStartEdit}
                >
                  <Pencil />
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * ReviewBlock variant that takes structured data directly (no parsing)
 * Used when review data is available from muxMetadata
 */
export const ReviewBlockFromData: React.FC<ReviewBlockFromDataProps> = ({
  data,
  onRemove,
  onEditComment,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(data.userNote);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Format code for diff display - add context markers if needed
  const diffContent = useMemo(() => {
    if (!data.selectedCode) return "";
    const lines = data.selectedCode.split("\n");
    const hasDiffMarkers = lines.some((l) => /^[+-\s]/.test(l));
    if (hasDiffMarkers) return data.selectedCode;
    return lines.map((l) => ` ${l}`).join("\n");
  }, [data.selectedCode]);

  const handleStartEdit = useCallback(() => {
    setEditValue(data.userNote);
    setIsEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [data.userNote]);

  const handleSaveEdit = useCallback(() => {
    if (onEditComment && editValue.trim() !== data.userNote) {
      onEditComment(editValue.trim());
    }
    setIsEditing(false);
  }, [editValue, data.userNote, onEditComment]);

  const handleCancelEdit = useCallback(() => {
    setEditValue(data.userNote);
    setIsEditing(false);
  }, [data.userNote]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSaveEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleCancelEdit();
      }
    },
    [handleSaveEdit, handleCancelEdit]
  );

  return (
    <div className="overflow-hidden rounded border border-[var(--color-review-accent)]/30 bg-[var(--color-review-accent)]/5">
      {/* Header */}
      <div className="flex items-center gap-1.5 border-b border-[var(--color-review-accent)]/20 bg-[var(--color-review-accent)]/10 px-2 py-1 text-xs">
        <MessageSquare className="size-3 shrink-0 text-[var(--color-review-accent)]" />
        <span className="text-primary min-w-0 flex-1 truncate font-mono">
          {data.filePath}:{data.lineRange}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-muted hover:text-error -mr-0.5 flex shrink-0 items-center justify-center rounded p-0.5 transition-colors"
            title="Remove from message"
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      {/* Code snippet */}
      {data.selectedCode && (
        <div className="max-h-64 overflow-auto border-b border-[var(--color-review-accent)]/20 text-[11px]">
          <DiffRenderer
            content={diffContent}
            showLineNumbers={false}
            fontSize="11px"
            filePath={data.filePath}
            className="rounded-none"
          />
        </div>
      )}

      {/* Comment - editable when onEditComment provided */}
      {(data.userNote || onEditComment) && (
        <div className="group/comment px-2 py-1">
          {isEditing ? (
            <div className="space-y-1">
              <textarea
                ref={textareaRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                className="text-primary w-full resize-none rounded border border-[var(--color-review-accent)]/40 bg-[var(--color-review-accent)]/10 px-1.5 py-1 text-xs focus:border-[var(--color-review-accent)]/60 focus:outline-none"
                rows={2}
                placeholder="Your comment..."
              />
              <div className="flex items-center justify-end gap-1">
                <span className="text-muted mr-1 text-[10px]">⌘Enter save, Esc cancel</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={handleCancelEdit}
                >
                  <X className="mr-0.5 size-2.5" />
                  Cancel
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={handleSaveEdit}
                >
                  <Check className="mr-0.5 size-2.5" />
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-1">
              <blockquote className="text-primary flex-1 border-l-2 border-[var(--color-review-accent)] pl-1.5 text-xs italic">
                {data.userNote || <span className="text-muted">No comment</span>}
              </blockquote>
              {onEditComment && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5 shrink-0 opacity-0 transition-opacity group-hover/comment:opacity-100 [&_svg]:size-3"
                  onClick={handleStartEdit}
                >
                  <Pencil />
                </Button>
              )}
            </div>
          )}
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
    <div className="space-y-2">
      {segments.map((segment, idx) =>
        segment.type === "review" ? (
          <ReviewBlock key={idx} content={segment.content} />
        ) : (
          <pre key={idx} className={textClassName}>
            {segment.content.trim()}
          </pre>
        )
      )}
    </div>
  );
};
