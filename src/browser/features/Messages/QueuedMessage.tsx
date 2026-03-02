import React, { useState } from "react";
import type { QueuedMessage as QueuedMessageType } from "@/common/types/message";
import { cn } from "@/common/lib/utils";
import { Pencil, Send } from "lucide-react";
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
  const [isSending, setIsSending] = useState(false);
  const preview = deriveQueuedPreview(message);

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
    <div
      className={cn("border-border bg-dark border-t px-[15px]", className)}
      data-component="QueuedMessageBanner"
    >
      <div className="mx-auto w-full max-w-4xl py-1.5">
        <div
          className="border-border-medium bg-background-secondary/80 rounded-md border px-2.5 py-1.5"
          data-component="QueuedMessageCard"
        >
          <div>
            <span className="text-muted shrink-0 text-[11px] font-semibold tracking-wide uppercase">
              Queued
            </span>
            <div className="mt-0.5">
              <UserMessageContent
                content={preview.sanitizedText || preview.fallbackLabel}
                reviews={message.reviews}
                fileParts={message.fileParts}
                variant="queued"
              />
            </div>
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
      </div>
    </div>
  );
};
