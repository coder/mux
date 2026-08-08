import React from "react";
import { MessageSquare, X } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { ChatInputDecoration } from "@/browser/components/ChatPane/ChatInputDecoration";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { getAttachedReviewsExpandedKey } from "@/common/constants/storage";
import { ReviewBlockFromData } from "../Shared/ReviewBlock";
import type { Review } from "@/common/types/review";

export interface AttachedReviewsPanelProps {
  workspaceId: string;
  reviews: Review[];
  onDetachAll?: () => void;
  onDetach?: (reviewId: string) => void;
  onCheck?: (reviewId: string) => void;
  onDelete?: (reviewId: string) => void;
  onUpdateNote?: (reviewId: string, note: string) => void;
}

/**
 * Displays reviews attached to the pending message as a collapsible chat-input
 * decoration. Reuses the {@link ChatInputDecoration} primitive so the panel
 * reads with the same collapsed chrome as the other composer decorations and so
 * a long list of attachments can be tucked away without detaching them. The
 * collapsed/expanded intent persists per-workspace; the panel defaults to
 * expanded to preserve the prior always-visible behavior. The summary surfaces
 * the count, and "Clear all" lives in the expanded body when multiple reviews
 * are attached.
 */
export const AttachedReviewsPanel: React.FC<AttachedReviewsPanelProps> = ({
  workspaceId,
  reviews,
  onDetachAll,
  onDetach,
  onCheck,
  onDelete,
  onUpdateNote,
}) => {
  const [expanded, setExpanded] = usePersistedState(
    getAttachedReviewsExpandedKey(workspaceId),
    true
  );

  if (reviews.length === 0) return null;

  return (
    <ChatInputDecoration
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      dataComponent="AttachedReviewsPanel"
      // Unlike the decorations stacked above the composer, this panel renders
      // inside the chat-input card (which already supplies the gutter), so drop
      // the primitive's top border + horizontal padding and keep a bottom
      // divider above the textarea, matching the panel's prior placement.
      className="border-t-0 border-b px-0"
      contentClassName="max-h-[50vh] space-y-2 overflow-y-auto py-1.5"
      summary={
        <>
          <MessageSquare className="size-3.5 text-[var(--color-review-accent)] transition-colors" />
          <span className="text-muted group-hover:text-secondary transition-colors">
            <span className="font-medium">{reviews.length}</span> review
            {reviews.length !== 1 && "s"} attached
          </span>
        </>
      }
      renderExpanded={() => (
        <>
          {onDetachAll && reviews.length > 1 && (
            <div className="flex items-center justify-end">
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
            </div>
          )}
          {reviews.map((review) => (
            <ReviewBlockFromData
              key={review.id}
              data={review.data}
              onComplete={onCheck ? () => onCheck(review.id) : undefined}
              onDetach={onDetach ? () => onDetach(review.id) : undefined}
              onDelete={onDelete ? () => onDelete(review.id) : undefined}
              onEditComment={
                onUpdateNote ? (newNote) => onUpdateNote(review.id, newNote) : undefined
              }
            />
          ))}
        </>
      )}
    />
  );
};
