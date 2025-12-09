import React from "react";
import type { DisplayedMessage, ReviewNoteDataForDisplay } from "@/common/types/message";
import type { ButtonConfig } from "./MessageWindow";
import { MessageWindow } from "./MessageWindow";
import { TerminalOutput } from "./TerminalOutput";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { copyToClipboard } from "@/browser/utils/clipboard";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { VIM_ENABLED_KEY } from "@/common/constants/storage";
import { Clipboard, ClipboardCheck, Pencil } from "lucide-react";
import { ReviewBlockFromData } from "../shared/ReviewBlock";

/** Helper component to render reviews from structured data with optional text */
const ReviewsWithText: React.FC<{
  reviews: ReviewNoteDataForDisplay[];
  textContent: string;
}> = ({ reviews, textContent }) => (
  <div className="space-y-2">
    {reviews.map((review, idx) => (
      <ReviewBlockFromData key={idx} data={review} />
    ))}
    {textContent && (
      <pre className="font-primary m-0 leading-6 break-words whitespace-pre-wrap text-[var(--color-user-text)]">
        {textContent}
      </pre>
    )}
  </div>
);

interface UserMessageProps {
  message: DisplayedMessage & { type: "user" };
  className?: string;
  onEdit?: (messageId: string, content: string) => void;
  isCompacting?: boolean;
  clipboardWriteText?: (data: string) => Promise<void>;
}

export const UserMessage: React.FC<UserMessageProps> = ({
  message,
  className,
  onEdit,
  isCompacting,
  clipboardWriteText = copyToClipboard,
}) => {
  const content = message.content;
  const [vimEnabled] = usePersistedState<boolean>(VIM_ENABLED_KEY, false, { listener: true });

  console.assert(
    typeof clipboardWriteText === "function",
    "UserMessage expects clipboardWriteText to be a callable function."
  );

  // Check if this is a local command output
  const isLocalCommandOutput =
    content.startsWith("<local-command-stdout>") && content.endsWith("</local-command-stdout>");

  // Extract the actual output if it's a local command
  const extractedOutput = isLocalCommandOutput
    ? content.slice("<local-command-stdout>".length, -"</local-command-stdout>".length).trim()
    : "";

  // Copy to clipboard with feedback
  const { copied, copyToClipboard } = useCopyToClipboard(clipboardWriteText);

  const handleEdit = () => {
    if (onEdit && !isLocalCommandOutput) {
      onEdit(message.historyId, content);
    }
  };

  // Keep Copy and Edit buttons visible (most common actions)
  // Kebab menu saves horizontal space by collapsing less-used actions
  const buttons: ButtonConfig[] = [
    ...(onEdit && !isLocalCommandOutput
      ? [
          {
            label: "Edit",
            onClick: handleEdit,
            disabled: isCompacting,
            icon: <Pencil />,
            tooltip: isCompacting
              ? `Cannot edit while compacting (${formatKeybind(vimEnabled ? KEYBINDS.INTERRUPT_STREAM_VIM : KEYBINDS.INTERRUPT_STREAM_NORMAL)} to cancel)`
              : undefined,
          },
        ]
      : []),
    {
      label: copied ? "Copied" : "Copy",
      onClick: () => void copyToClipboard(content),
      icon: copied ? <ClipboardCheck /> : <Clipboard />,
    },
  ];

  // If it's a local command output, render with TerminalOutput
  if (isLocalCommandOutput) {
    return (
      <MessageWindow
        label={null}
        message={message}
        buttons={buttons}
        className={className}
        variant="user"
      >
        <TerminalOutput output={extractedOutput} isError={false} />
      </MessageWindow>
    );
  }

  // Check if we have structured review data in metadata
  const hasReviews = message.reviews && message.reviews.length > 0;

  // Extract plain text content (without review tags) for display alongside review blocks
  const plainTextContent = hasReviews
    ? content.replace(/<review>[\s\S]*?<\/review>\s*/g, "").trim()
    : content;

  // Otherwise, render as normal user message
  return (
    <MessageWindow
      label={null}
      message={message}
      buttons={buttons}
      className={className}
      variant="user"
    >
      {hasReviews ? (
        // Use structured review data from metadata
        <ReviewsWithText reviews={message.reviews!} textContent={plainTextContent} />
      ) : (
        // No reviews - just plain text
        content && (
          <pre className="font-primary m-0 leading-6 break-words whitespace-pre-wrap text-[var(--color-user-text)]">
            {content}
          </pre>
        )
      )}
      {message.imageParts && message.imageParts.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3">
          {message.imageParts.map((img, idx) => (
            <img
              key={idx}
              src={img.url}
              alt={`Attachment ${idx + 1}`}
              className="max-h-[300px] max-w-72 rounded-xl border border-[var(--color-attachment-border)] object-cover"
            />
          ))}
        </div>
      )}
    </MessageWindow>
  );
};
