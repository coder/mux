/**
 * ReviewBlock - Renders review data as styled components
 *
 * Used in:
 * - UserMessage to display submitted reviews (from metadata via ReviewBlockFromData)
 * - ChatInput preview to show reviews before sending (via ReviewBlock with parsed content)
 */

import React, { useMemo, useState, useCallback, useRef } from "react";
import { MessageSquare, X, Pencil, Check } from "lucide-react";
import { DiffRenderer } from "./DiffRenderer";
import { Button } from "../ui/button";
import { matchesKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED INTERNAL COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

interface ReviewBlockCoreProps {
  filePath: string;
  lineRange: string;
  code: string;
  comment: string;
  onRemove?: () => void;
  onEditComment?: (newComment: string) => void;
}

/**
 * Core review block rendering - used by both ReviewBlock and ReviewBlockFromData
 */
const ReviewBlockCore: React.FC<ReviewBlockCoreProps> = ({
  filePath,
  lineRange,
  code,
  comment,
  onRemove,
  onEditComment,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(comment);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Format code for diff display - add context markers if needed
  const diffContent = useMemo(() => {
    if (!code) return "";
    const lines = code.split("\n");
    const hasDiffMarkers = lines.some((l) => /^[+-\s]/.test(l));
    if (hasDiffMarkers) return code;
    return lines.map((l) => ` ${l}`).join("\n");
  }, [code]);

  const handleStartEdit = useCallback(() => {
    setEditValue(comment);
    setIsEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [comment]);

  const handleSaveEdit = useCallback(() => {
    if (onEditComment && editValue.trim() !== comment) {
      onEditComment(editValue.trim());
    }
    setIsEditing(false);
  }, [editValue, comment, onEditComment]);

  const handleCancelEdit = useCallback(() => {
    setEditValue(comment);
    setIsEditing(false);
  }, [comment]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.SAVE_EDIT)) {
        e.preventDefault();
        handleSaveEdit();
      } else if (matchesKeybind(e, KEYBINDS.CANCEL_EDIT)) {
        e.preventDefault();
        handleCancelEdit();
      }
    },
    [handleSaveEdit, handleCancelEdit]
  );

  return (
    <div className="min-w-0 overflow-hidden rounded border border-[var(--color-review-accent)]/30 bg-[var(--color-review-accent)]/5">
      {/* Header */}
      <div className="flex items-center gap-1.5 border-b border-[var(--color-review-accent)]/20 bg-[var(--color-review-accent)]/10 px-2 py-1 text-xs">
        <MessageSquare className="size-3 shrink-0 text-[var(--color-review-accent)]" />
        <span className="text-primary min-w-0 flex-1 truncate font-mono">
          {filePath}:{lineRange}
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

      {/* Code snippet - horizontal scroll for long lines, vertical scroll limited to max-h-64 */}
      {code && (
        <div className="max-h-64 overflow-auto border-b border-[var(--color-review-accent)]/20 text-[11px]">
          <DiffRenderer
            content={diffContent}
            showLineNumbers={false}
            fontSize="11px"
            filePath={filePath}
            maxHeight="none"
            className="min-w-fit rounded-none"
          />
        </div>
      )}

      {/* Comment - editable when onEditComment provided */}
      {(comment || onEditComment) && (
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
                {comment || <span className="text-muted">No comment</span>}
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

// ═══════════════════════════════════════════════════════════════════════════════
// PARSING (for legacy messages without metadata)
// ═══════════════════════════════════════════════════════════════════════════════

interface ParsedReview {
  filePath: string;
  lineRange: string;
  code: string;
  comment: string;
}

/**
 * Parse review format: Re path:lines\n\`\`\`\ncode\n\`\`\`\n> comment
 * Used for legacy messages that don't have structured metadata
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

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface ReviewBlockProps {
  /** Raw content inside the <review> tags (requires parsing) */
  content: string;
  /** Optional callback to remove the review */
  onRemove?: () => void;
  /** Optional callback to edit the comment */
  onEditComment?: (newComment: string) => void;
}

/**
 * ReviewBlock that parses content string (legacy format)
 * Used by MarkdownComponents and ContentWithReviews for backward compatibility
 */
export const ReviewBlock: React.FC<ReviewBlockProps> = ({ content, onRemove, onEditComment }) => {
  const parsed = useMemo(() => parseReviewContent(content), [content]);
  return (
    <ReviewBlockCore
      filePath={parsed.filePath}
      lineRange={parsed.lineRange}
      code={parsed.code}
      comment={parsed.comment}
      onRemove={onRemove}
      onEditComment={onEditComment}
    />
  );
};

interface ReviewBlockFromDataProps {
  /** Structured review data (no parsing needed) */
  data: ReviewNoteDataForDisplay;
  /** Optional callback to remove the review */
  onRemove?: () => void;
  /** Optional callback to edit the comment */
  onEditComment?: (newComment: string) => void;
}

/**
 * ReviewBlock that takes structured data directly (preferred)
 * Used when review data is available from muxMetadata
 */
export const ReviewBlockFromData: React.FC<ReviewBlockFromDataProps> = ({
  data,
  onRemove,
  onEditComment,
}) => {
  return (
    <ReviewBlockCore
      filePath={data.filePath}
      lineRange={data.lineRange}
      code={data.selectedCode}
      comment={data.userNote}
      onRemove={onRemove}
      onEditComment={onEditComment}
    />
  );
};
