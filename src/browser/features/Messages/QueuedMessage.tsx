import React, { useState } from "react";
import type { FilePart } from "@/common/orpc/schemas";
import type { QueuedMessage as QueuedMessageType } from "@/common/types/message";
import { cn } from "@/common/lib/utils";
import { MessageSquare, Paperclip, Pencil, Send } from "lucide-react";

interface QueuedMessageProps {
  message: QueuedMessageType;
  className?: string;
  onEdit?: () => void;
  onSendImmediately?: () => Promise<void>;
}

interface QueuedPreview {
  previewText: string;
  imageParts: FilePart[];
  nonImageFileCount: number;
  reviewCount: number;
}

function getBaseMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}

export function deriveQueuedPreview(message: QueuedMessageType): QueuedPreview {
  const reviews = message.reviews ?? [];
  const fileParts = message.fileParts ?? [];
  const reviewCount = reviews.length;
  const sanitizedContent =
    reviewCount > 0
      ? message.content.replace(/<review>[\s\S]*?<\/review>\s*/g, "").trim()
      : message.content;

  const imageParts: FilePart[] = [];
  let nonImageFileCount = 0;
  for (const part of fileParts) {
    if (getBaseMediaType(part.mediaType).startsWith("image/")) {
      imageParts.push(part);
      continue;
    }

    nonImageFileCount += 1;
  }

  const hasAuxiliaryContent = imageParts.length > 0 || nonImageFileCount > 0 || reviewCount > 0;
  const auxiliaryPreview = [
    nonImageFileCount > 0 ? `${nonImageFileCount} file${nonImageFileCount === 1 ? "" : "s"}` : null,
    imageParts.length > 0
      ? `${imageParts.length} image${imageParts.length === 1 ? "" : "s"}`
      : null,
    reviewCount > 0 ? `${reviewCount} review${reviewCount === 1 ? "" : "s"}` : null,
  ]
    .filter((item): item is string => item !== null)
    .join(" · ");

  const previewText =
    sanitizedContent || (hasAuxiliaryContent ? auxiliaryPreview : "Queued message ready");

  return {
    previewText,
    imageParts,
    nonImageFileCount,
    reviewCount,
  };
}

export const QueuedMessage: React.FC<QueuedMessageProps> = ({
  message,
  className,
  onEdit,
  onSendImmediately,
}) => {
  const [isSending, setIsSending] = useState(false);
  const { previewText, imageParts, nonImageFileCount, reviewCount } = deriveQueuedPreview(message);

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
            {imageParts.length > 0 && (
              <div className="mt-1 flex gap-1.5">
                {imageParts.slice(0, 3).map((part, index) => (
                  <img
                    key={index}
                    src={part.url}
                    alt={`Queued image ${index + 1}`}
                    className="border-border-medium h-14 w-14 rounded border object-cover"
                  />
                ))}
                {imageParts.length > 3 && (
                  <span className="text-muted border-border-medium flex h-14 w-14 items-center justify-center rounded border border-dashed text-xs">
                    +{imageParts.length - 3}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5">
            {nonImageFileCount > 0 && (
              <span className="text-muted flex shrink-0 items-center gap-1 text-xs">
                <Paperclip className="size-3" />
                <span>
                  {nonImageFileCount} file{nonImageFileCount === 1 ? "" : "s"}
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
