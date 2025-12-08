/**
 * PendingReviewsBanner - Shows pending code reviews in the chat area
 * Displays as a thin collapsible stripe above the chat input
 *
 * Uses shadcn/ui Button component and semantic Tailwind color classes
 * that map to CSS variables defined in globals.css.
 */

import React, { useState, useCallback, useMemo } from "react";
import {
  ChevronDown,
  ChevronUp,
  Check,
  Undo2,
  Send,
  Trash2,
  MessageSquare,
  Eye,
  EyeOff,
} from "lucide-react";
import { cn } from "@/common/lib/utils";
import { Button } from "./ui/button";
import { Tooltip, TooltipWrapper } from "./Tooltip";
import type { PendingReview } from "@/common/types/review";

interface PendingReviewsBannerProps {
  /** All reviews (pending and checked) */
  reviews: PendingReview[];
  /** Count of pending reviews */
  pendingCount: number;
  /** Count of checked reviews */
  checkedCount: number;
  /** Mark a review as checked */
  onCheck: (reviewId: string) => void;
  /** Uncheck a review */
  onUncheck: (reviewId: string) => void;
  /** Send review content to chat input */
  onSendToChat: (content: string) => void;
  /** Remove a review */
  onRemove: (reviewId: string) => void;
  /** Clear all checked reviews */
  onClearChecked: () => void;
}

/**
 * Extract a short summary from review content for display
 */
function getReviewSummary(review: PendingReview): string {
  // Extract the user's note from the review content (after the code block)
  const noteMatch = /```\n> (.+?)\n<\/review>/s.exec(review.content);
  if (noteMatch) {
    const note = noteMatch[1].trim();
    return note.length > 50 ? note.slice(0, 50) + "…" : note;
  }
  return `${review.filePath}:${review.lineRange}`;
}

/**
 * Single review item in the list
 */
const ReviewItem: React.FC<{
  review: PendingReview;
  onCheck: () => void;
  onUncheck: () => void;
  onSendToChat: () => void;
  onRemove: () => void;
}> = ({ review, onCheck, onUncheck, onSendToChat, onRemove }) => {
  const isChecked = review.status === "checked";

  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors",
        isChecked ? "bg-hover opacity-60" : "bg-border-medium/30 hover:bg-hover"
      )}
    >
      {/* Check/Uncheck button */}
      <TooltipWrapper inline>
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-5 w-5 shrink-0 [&_svg]:size-3", isChecked && "text-success")}
          onClick={isChecked ? onUncheck : onCheck}
        >
          {isChecked ? <Undo2 /> : <Check />}
        </Button>
        <Tooltip align="center">{isChecked ? "Mark as pending" : "Mark as done"}</Tooltip>
      </TooltipWrapper>

      {/* Review info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[var(--color-review-accent)]">
            {review.filePath}:{review.lineRange}
          </span>
        </div>
        <div className="text-muted truncate">{getReviewSummary(review)}</div>
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <TooltipWrapper inline>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 [&_svg]:size-3"
            onClick={onSendToChat}
          >
            <Send />
          </Button>
          <Tooltip align="center">Send to chat</Tooltip>
        </TooltipWrapper>

        <TooltipWrapper inline>
          <Button
            variant="ghost"
            size="icon"
            className="text-error h-5 w-5 [&_svg]:size-3"
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
          <Tooltip align="center">Remove</Tooltip>
        </TooltipWrapper>
      </div>
    </div>
  );
};

export const PendingReviewsBanner: React.FC<PendingReviewsBannerProps> = ({
  reviews,
  pendingCount,
  checkedCount,
  onCheck,
  onUncheck,
  onSendToChat,
  onRemove,
  onClearChecked,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showChecked, setShowChecked] = useState(false);

  // Filter reviews based on view mode
  const displayedReviews = useMemo(() => {
    if (showChecked) {
      return reviews.filter((r) => r.status === "checked");
    }
    return reviews.filter((r) => r.status === "pending");
  }, [reviews, showChecked]);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const handleToggleShowChecked = useCallback(() => {
    setShowChecked((prev) => !prev);
  }, []);

  // Don't show anything if no reviews
  if (reviews.length === 0) {
    return null;
  }

  return (
    <div className="border-border bg-dark border-t">
      {/* Collapsed banner - thin stripe */}
      <button
        type="button"
        onClick={handleToggle}
        className="hover:bg-hover flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors"
      >
        <MessageSquare className="h-3.5 w-3.5 text-[var(--color-review-accent)]" />
        <span className="text-secondary">
          {pendingCount > 0 ? (
            <>
              <span className="font-medium text-[var(--color-review-accent)]">{pendingCount}</span>
              {" pending review"}
              {pendingCount !== 1 && "s"}
            </>
          ) : (
            <span className="text-muted">No pending reviews</span>
          )}
          {checkedCount > 0 && <span className="text-muted"> · {checkedCount} checked</span>}
        </span>
        <div className="ml-auto">
          {isExpanded ? (
            <ChevronDown className="text-muted h-3.5 w-3.5" />
          ) : (
            <ChevronUp className="text-muted h-3.5 w-3.5" />
          )}
        </div>
      </button>

      {/* Expanded view */}
      {isExpanded && (
        <div className="border-border border-t px-3 py-2">
          {/* View toggle and actions */}
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TooltipWrapper inline>
                <Button
                  variant={showChecked ? "secondary" : "ghost"}
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={handleToggleShowChecked}
                >
                  {showChecked ? (
                    <Eye className="mr-1 h-3 w-3" />
                  ) : (
                    <EyeOff className="mr-1 h-3 w-3" />
                  )}
                  {showChecked ? "Checked" : "Pending"}
                </Button>
                <Tooltip align="center">
                  {showChecked ? "Showing checked reviews" : "Showing pending reviews"}
                </Tooltip>
              </TooltipWrapper>
            </div>

            {showChecked && checkedCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-error h-6 px-2 text-xs"
                onClick={onClearChecked}
              >
                <Trash2 className="mr-1 h-3 w-3" />
                Clear all
              </Button>
            )}
          </div>

          {/* Review list */}
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {displayedReviews.length === 0 ? (
              <div className="text-muted py-3 text-center text-xs">
                {showChecked ? "No checked reviews" : "No pending reviews"}
              </div>
            ) : (
              displayedReviews.map((review) => (
                <ReviewItem
                  key={review.id}
                  review={review}
                  onCheck={() => onCheck(review.id)}
                  onUncheck={() => onUncheck(review.id)}
                  onSendToChat={() => onSendToChat(review.content)}
                  onRemove={() => onRemove(review.id)}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
