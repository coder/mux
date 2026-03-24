import React, { useState } from "react";
import type { QueuedMessage as QueuedMessageType } from "@/common/types/message";
import { Pencil, Send } from "lucide-react";
import { ChatInputDecoration } from "@/browser/components/ChatPane/ChatInputDecoration";
import { UserMessageContent } from "@/browser/features/Messages/UserMessageContent";

interface QueuedMessageProps {
  message: QueuedMessageType;
  className?: string;
  onEdit?: () => void;
  onSendImmediately?: () => Promise<void>;
}

interface QueuedPreview {
  sanitizedText: string;
  fallbackLabel: string;
}

export function deriveQueuedPreview(message: QueuedMessageType): QueuedPreview {
  const hasReviews = (message.reviews?.length ?? 0) > 0;
  const sanitizedText = hasReviews
    ? message.content.replace(/<review>[\s\S]*?<\/review>\s*/g, "").trim()
    : message.content;

  return {
    sanitizedText,
    fallbackLabel: "Queued message ready",
  };
}

export const QueuedMessage: React.FC<QueuedMessageProps> = ({
  message,
  className,
  onEdit,
  onSendImmediately,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const preview = deriveQueuedPreview(message);
  const queueStatusLabel =
    message.queueDispatchMode === "turn-end" ? "Sending after turn" : "Sending after step";

  const handleToggle = () => {
    setIsExpanded((prev) => !prev);
  };

  const handleSendImmediately = async () => {
    if (isSending || !onSendImmediately) return;
    setIsSending(true);
    try {
      await onSendImmediately();
    } finally {
      setIsSending(false);
    }
  };

  return (
    <ChatInputDecoration
      expanded={isExpanded}
      onToggle={handleToggle}
      className={className}
      contentClassName="py-1.5"
      dataComponent="QueuedMessageBanner"
      summary={
        <>
          <Send className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
          <span className="text-muted group-hover:text-secondary transition-colors">
            Queued - {queueStatusLabel}
          </span>
        </>
      }
      renderExpanded={() => (
        <div
          className="border-border-medium bg-background-secondary/80 rounded-md border px-2.5 py-1.5"
          data-component="QueuedMessageCard"
        >
          {/* Keep queued drafts bounded so long content never pushes the composer off-screen. */}
          <div className="max-h-[40vh] overflow-y-auto">
            <UserMessageContent
              content={preview.sanitizedText || preview.fallbackLabel}
              reviews={message.reviews}
              fileParts={message.fileParts}
              variant="queued"
            />
          </div>

          <div className="mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5">
            {onEdit && (
              <button
                type="button"
                onClick={onEdit}
                className="text-muted hover:text-secondary flex items-center gap-1 text-xs transition-colors"
              >
                <Pencil className="size-3" />
                Edit
              </button>
            )}

            {onSendImmediately && (
              <button
                type="button"
                onClick={() => void handleSendImmediately()}
                disabled={isSending}
                className="text-muted hover:text-secondary flex items-center gap-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send className="size-3" />
                {isSending ? "Sending…" : "Send now"}
              </button>
            )}
          </div>
        </div>
      )}
    />
  );
};
