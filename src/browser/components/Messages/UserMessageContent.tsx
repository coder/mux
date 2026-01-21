import React from "react";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";
import type { ImagePart } from "@/common/orpc/schemas";
import { ReviewBlockFromData } from "../shared/ReviewBlock";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface UserMessageContentProps {
  content: string;
  reviews?: ReviewNoteDataForDisplay[];
  imageParts?: ImagePart[];
  /** Controls styling: "sent" for full styling, "queued" for muted preview */
  variant: "sent" | "queued";
}

const markdownStyles: Record<UserMessageContentProps["variant"], React.CSSProperties> = {
  sent: {
    color: "var(--color-user-text)",
    overflowWrap: "break-word",
    wordBreak: "break-word",
  },
  queued: {
    color: "var(--color-subtle)",
    fontFamily: "var(--font-monospace)",
    fontSize: "12px",
    lineHeight: "16px",
    overflowWrap: "break-word",
    wordBreak: "break-word",
    opacity: 0.9,
  },
};

const imageContainerStyles = {
  sent: "mt-3 flex flex-wrap gap-3",
  queued: "mt-2 flex flex-wrap gap-2",
} as const;

const markdownClassName = "user-message-markdown";

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
          {textContent && (
            <MarkdownRenderer
              content={textContent}
              className={markdownClassName}
              style={markdownStyles[variant]}
            />
          )}
        </div>
      ) : (
        content && (
          <MarkdownRenderer
            content={content}
            className={markdownClassName}
            style={markdownStyles[variant]}
          />
        )
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
