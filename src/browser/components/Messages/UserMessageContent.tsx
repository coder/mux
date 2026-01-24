import React from "react";
import { FileText } from "lucide-react";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";
import type { FilePart } from "@/common/orpc/schemas";
import { ReviewBlockFromData } from "../shared/ReviewBlock";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface UserMessageContentProps {
  content: string;
  commandPrefix?: string;
  reviews?: ReviewNoteDataForDisplay[];
  fileParts?: FilePart[];
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

function getBaseMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}

const fileAttachmentStyles = {
  sent: "flex max-w-80 items-center gap-2 rounded-xl border border-[var(--color-attachment-border)] px-3 py-2 text-sm text-[var(--color-subtle)]",
  queued:
    "border-border-light flex max-w-80 items-center gap-2 rounded border px-2 py-1 text-xs text-[var(--color-subtle)]",
} as const;
const imageStyles = {
  sent: "max-h-[300px] max-w-72 rounded-xl border border-[var(--color-attachment-border)] object-cover",
  queued: "border-border-light max-h-[300px] max-w-80 rounded border",
} as const;

/** Styled command prefix (e.g., "/compact" or "/skill-name") */
const CommandPrefixBadge: React.FC<{ prefix: string }> = ({ prefix }) => (
  <span className="font-mono text-[13px] font-medium text-[var(--color-plan-mode-light)]">
    {prefix}
  </span>
);

/**
 * Shared content renderer for user messages (sent and queued).
 * Handles reviews, text content, and image attachments.
 */
export const UserMessageContent: React.FC<UserMessageContentProps> = ({
  content,
  commandPrefix,
  reviews,
  fileParts,
  variant,
}) => {
  const hasReviews = reviews && reviews.length > 0;

  // Strip review tags from text when displaying alongside review blocks
  const textContent = hasReviews
    ? content.replace(/<review>[\s\S]*?<\/review>\s*/g, "").trim()
    : content;

  // Check if content starts with the command prefix
  const shouldHighlightPrefix =
    commandPrefix && textContent.startsWith(commandPrefix) ? commandPrefix : undefined;

  // Content after the prefix (if highlighting)
  const remainingContent = shouldHighlightPrefix
    ? textContent.slice(shouldHighlightPrefix.length)
    : textContent;

  // Render text content with optional command prefix badge
  const renderTextContent = () => {
    if (!remainingContent && !shouldHighlightPrefix) return null;

    // No prefix highlighting - render markdown directly without wrapper
    if (!shouldHighlightPrefix) {
      return (
        <MarkdownRenderer
          content={textContent}
          className={markdownClassName}
          style={markdownStyles[variant]}
        />
      );
    }

    // Check what whitespace follows the prefix to preserve visual layout
    const charAfterPrefix = textContent.charAt(shouldHighlightPrefix.length);
    const hasSpaceAfterPrefix = charAfterPrefix === " ";
    const hasNewlineAfterPrefix = charAfterPrefix === "\n";

    // Newline after prefix: block layout (badge on own line)
    // Space after prefix: inline layout (badge + content on same line)
    return (
      <div className={hasNewlineAfterPrefix ? "" : "flex flex-wrap items-baseline"}>
        <CommandPrefixBadge prefix={shouldHighlightPrefix} />
        {hasSpaceAfterPrefix && <span>&nbsp;</span>}
        {remainingContent.trim() && (
          <MarkdownRenderer
            content={remainingContent.trim()}
            className={markdownClassName}
            style={markdownStyles[variant]}
          />
        )}
      </div>
    );
  };

  return (
    <>
      {hasReviews ? (
        <div className="space-y-2">
          {reviews.map((review, idx) => (
            <ReviewBlockFromData key={idx} data={review} />
          ))}
          {renderTextContent()}
        </div>
      ) : (
        renderTextContent()
      )}
      {fileParts && fileParts.length > 0 && (
        <div className={imageContainerStyles[variant]}>
          {fileParts.map((part, idx) => {
            const baseMediaType = getBaseMediaType(part.mediaType);
            if (baseMediaType.startsWith("image/")) {
              return (
                <img
                  key={idx}
                  src={part.url}
                  alt={`Attachment ${idx + 1}`}
                  className={imageStyles[variant]}
                />
              );
            }

            const label =
              part.filename ??
              (baseMediaType === "application/pdf"
                ? "PDF attachment"
                : `Attachment (${baseMediaType})`);

            return (
              <a
                key={idx}
                href={part.url}
                target="_blank"
                rel="noreferrer"
                className={fileAttachmentStyles[variant]}
              >
                <FileText className="h-4 w-4 shrink-0" />
                <span className="truncate">{label}</span>
              </a>
            );
          })}
        </div>
      )}
    </>
  );
};
