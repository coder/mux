import React, { useState } from "react";
import type { QueuedMessage as QueuedMessageType } from "@/common/types/message";
import { cn } from "@/common/lib/utils";
import { MessageSquare, Paperclip, Pencil, Send } from "lucide-react";

interface QueuedMessageProps {
  message: QueuedMessageType;
  className?: string;
  onEdit?: () => void;
  onSendImmediately?: () => Promise<void>;
}

export const QueuedMessage: React.FC<QueuedMessageProps> = ({
  message,
  className,
  onEdit,
  onSendImmediately,
}) => {
  const [isSending, setIsSending] = useState(false);

  const fileCount = message.fileParts?.length ?? 0;
  const reviewCount = message.reviews?.length ?? 0;
  const hasAuxiliaryContent = fileCount > 0 || reviewCount > 0;
  const auxiliaryPreview = [
    fileCount > 0 ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : null,
    reviewCount > 0 ? `${reviewCount} review${reviewCount === 1 ? "" : "s"}` : null,
  ]
    .filter((item): item is string => item !== null)
    .join(" · ");
  const previewText =
    message.content || (hasAuxiliaryContent ? auxiliaryPreview : "Queued message ready");

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
            <div className="text-secondary mt-0.5 text-xs break-words whitespace-pre-wrap">
              {previewText}
            </div>
          </div>

          <div className="mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5">
            {fileCount > 0 && (
              <span className="text-muted flex shrink-0 items-center gap-1 text-xs">
                <Paperclip className="size-3" />
                <span>
                  {fileCount} file{fileCount === 1 ? "" : "s"}
                </span>
              </span>
            )}

            {reviewCount > 0 && (
              <span className="text-muted flex shrink-0 items-center gap-1 text-xs">
                <MessageSquare className="size-3" />
                <span>
                  {reviewCount} review{reviewCount === 1 ? "" : "s"}
                </span>
              </span>
            )}

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
