import React from "react";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";
import type { ImagePart } from "@/common/orpc/schemas";
import { ReviewBlockFromData } from "../shared/ReviewBlock";

interface UserMessageContentProps {
  content: string;
  reviews?: ReviewNoteDataForDisplay[];
  imageParts?: ImagePart[];
  /** Controls styling: "sent" for full styling, "queued" for muted preview */
  variant: "sent" | "queued";
}

const textStyles = {
  sent: "font-primary m-0 leading-6 break-words whitespace-pre-wrap text-[var(--color-user-text)]",
  queued: "text-subtle m-0 font-mono text-xs leading-4 break-words whitespace-pre-wrap opacity-90",
} as const;

const imageContainerStyles = {
  sent: "mt-3 flex flex-wrap gap-3",
  queued: "mt-2 flex flex-wrap gap-2",
} as const;

const imageStyles = {
  sent: "max-h-[300px] max-w-72 rounded-xl border border-[var(--color-attachment-border)] object-cover",
  queued: "border-border-light max-h-[300px] max-w-80 rounded border",
} as const;

/**
 * Shared content renderer for user messages (sent and queued).
 * Handles reviews, text content, and image attachments.
 */
export const UserMessageContent: React.FC<UserMessageContentProps> = ({
  content,
  reviews,
  imageParts,
  variant,
}) => {
  const hasReviews = reviews && reviews.length > 0;

  // Strip review tags from text when displaying alongside review blocks
  const textContent = hasReviews
    ? content.replace(/<review>[\s\S]*?<\/review>\s*/g, "").trim()
    : content;

  return (
    <>
      {hasReviews ? (
        <div className="space-y-2">
          {reviews.map((review, idx) => (
            <ReviewBlockFromData key={idx} data={review} />
          ))}
          {textContent && <pre className={textStyles[variant]}>{textContent}</pre>}
        </div>
      ) : (
        content && <pre className={textStyles[variant]}>{content}</pre>
      )}
      {imageParts && imageParts.length > 0 && (
        <div className={imageContainerStyles[variant]}>
          {imageParts.map((img, idx) => (
            <img
              key={idx}
              src={img.url}
              alt={`Attachment ${idx + 1}`}
              className={imageStyles[variant]}
            />
          ))}
        </div>
      )}
    </>
  );
};
