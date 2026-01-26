import React from "react";
import { X } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { ReviewBlockFromData } from "../shared/ReviewBlock";
import type { Review } from "@/common/types/review";

export interface AttachedReviewsPanelProps {
  reviews: Review[];
  onDetachAll?: () => void;
  onDetach?: (reviewId: string) => void;
  onCheck?: (reviewId: string) => void;
  onDelete?: (reviewId: string) => void;
  onUpdateNote?: (reviewId: string, note: string) => void;
}

/**
 * Displays attached reviews in the chat input area.
 * Shows a header with count and "Clear all" button when multiple reviews attached.
 */
export const AttachedReviewsPanel: React.FC<AttachedReviewsPanelProps> = ({
  reviews,
  onDetachAll,
  onDetach,
  onCheck,
  onDelete,
  onUpdateNote,
}) => {
  if (reviews.length === 0) return null;

  return (
    <div className="border-border max-h-[50vh] space-y-2 overflow-y-auto border-b px-1.5 py-1.5">
      {/* Header with count and clear all button */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted font-medium">
          {reviews.length} review{reviews.length !== 1 && "s"} attached
        </span>
        {onDetachAll && reviews.length > 1 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onDetachAll}
                className="text-muted hover:text-error flex items-center gap-1 text-xs transition-colors"
              >
                <X className="size-3" />
                Clear all
              </button>
            </TooltipTrigger>
            <TooltipContent>Remove all reviews from message</TooltipContent>
          </Tooltip>
        )}
      </div>
      {reviews.map((review) => (
        <ReviewBlockFromData
          key={review.id}
          data={review.data}
          onComplete={onCheck ? () => onCheck(review.id) : undefined}
          onDetach={onDetach ? () => onDetach(review.id) : undefined}
          onDelete={onDelete ? () => onDelete(review.id) : undefined}
          onEditComment={onUpdateNote ? (newNote) => onUpdateNote(review.id, newNote) : undefined}
        />
      ))}
    </div>
  );
};
