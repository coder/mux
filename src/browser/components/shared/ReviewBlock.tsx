/**
 * ReviewBlock - Renders review data as styled components
 *
 * Used in:
 * - UserMessage to display submitted reviews (from metadata)
 * - ChatInput preview to show reviews before sending
 */

import React, { useState, useCallback, useRef, useMemo } from "react";
import { MessageSquare, X, Pencil, Check, Trash2 } from "lucide-react";
import { DiffRenderer } from "./DiffRenderer";
import { Button } from "../ui/button";
import { matchesKeybind, formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED INTERNAL COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

interface ReviewBlockCoreProps {
  filePath: string;
  lineRange: string;
  code: string;
  diff?: string;
  oldStart?: number;
  newStart?: number;
  comment: string;
  /** Detach from chat (sets status back to pending) */
  onDetach?: () => void;
  /** Mark as complete (checked) */
  onComplete?: () => void;
  /** Permanently delete the review */
  onDelete?: () => void;
  onEditComment?: (newComment: string) => void;
}

/**
 * Core review block rendering - used by both ReviewBlock and ReviewBlockFromData
 */
const ReviewBlockCore: React.FC<ReviewBlockCoreProps> = ({
  filePath,
  lineRange,
  code,
  diff,
  oldStart,
  newStart,
  comment,
  onDetach,
  onComplete,
  onDelete,
  onEditComment,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(comment);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Check if code has embedded line numbers (from review selection)
  // Format: "12 14 + content" or " 1  2   content"
  const hasEmbeddedLineNumbers = useMemo(() => {
    if (!code) return false;
    const firstLine = code.split("\n")[0] ?? "";
    // Match: optional digits, space, optional digits, space, then +/-/space
    return /^\s*\d*\s+\d*\s+[+-\s]/.test(firstLine);
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
      {/* Header - actions left of file path (consistent with ReviewsBanner), trash on right */}
      <div className="flex items-center gap-1 border-b border-[var(--color-review-accent)]/20 bg-[var(--color-review-accent)]/10 px-2 py-1 text-xs">
        {/* Safe actions on left: complete and detach */}
        {onComplete && (
          <button
            type="button"
            onClick={onComplete}
            className="text-muted hover:text-success flex shrink-0 items-center justify-center rounded p-0.5 transition-colors"
            title="Mark as done"
          >
            <Check className="size-3" />
          </button>
        )}
        {onDetach && (
          <button
            type="button"
            onClick={onDetach}
            className="text-muted hover:text-secondary flex shrink-0 items-center justify-center rounded p-0.5 transition-colors"
            title="Detach from message"
          >
            <X className="size-3" />
          </button>
        )}
        <MessageSquare className="size-3 shrink-0 text-[var(--color-review-accent)]" />
        <span className="text-primary min-w-0 flex-1 truncate font-mono">
          {filePath}:{lineRange}
        </span>
        {/* Destructive action on right */}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="text-muted hover:text-error flex shrink-0 items-center justify-center rounded p-0.5 transition-colors"
            title="Delete review"
          >
            <Trash2 className="size-3" />
          </button>
        )}
      </div>

      {/* Code snippet - horizontal scroll for long lines, vertical scroll limited to max-h-64 */}
      {(diff ?? code) && (
        <div className="max-h-64 overflow-auto border-b border-[var(--color-review-accent)]/20 text-[11px]">
          {diff ? (
            <DiffRenderer
              content={diff}
              showLineNumbers={true}
              oldStart={oldStart ?? 1}
              newStart={newStart ?? 1}
              fontSize="11px"
              filePath={filePath}
              maxHeight="none"
              className="min-w-fit rounded-none"
            />
          ) : hasEmbeddedLineNumbers ? (
            // Legacy: code with embedded line numbers - render as plain monospace
            <pre className="font-monospace bg-code-bg p-1.5 text-[11px] leading-[1.4] whitespace-pre">
              {code}
            </pre>
          ) : (
            // Standard diff format (without reliable start numbers) - highlight but omit gutters
            <DiffRenderer
              content={code}
              showLineNumbers={false}
              fontSize="11px"
              filePath={filePath}
              maxHeight="none"
              className="min-w-fit rounded-none"
            />
          )}
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
                <span className="text-muted mr-1 text-[10px]">
                  {formatKeybind(KEYBINDS.SAVE_EDIT)} save, Esc cancel
                </span>
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
// PUBLIC COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

interface ReviewBlockFromDataProps {
  /** Structured review data (no parsing needed) */
  data: ReviewNoteDataForDisplay;
  /** Detach from chat (sets status back to pending) */
  onDetach?: () => void;
  /** Mark as complete (checked) */
  onComplete?: () => void;
  /** Permanently delete the review */
  onDelete?: () => void;
  /** Optional callback to edit the comment */
  onEditComment?: (newComment: string) => void;
}

/**
 * ReviewBlock that takes structured data directly (preferred)
 * Used when review data is available from muxMetadata
 */
export const ReviewBlockFromData: React.FC<ReviewBlockFromDataProps> = ({
  data,
  onDetach,
  onComplete,
  onDelete,
  onEditComment,
}) => {
  return (
    <ReviewBlockCore
      filePath={data.filePath}
      lineRange={data.lineRange}
      code={data.selectedCode}
      diff={data.selectedDiff}
      oldStart={data.oldStart}
      newStart={data.newStart}
      comment={data.userNote}
      onDetach={onDetach}
      onComplete={onComplete}
      onDelete={onDelete}
      onEditComment={onEditComment}
    />
  );
};
