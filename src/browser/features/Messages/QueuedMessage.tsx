import React, { useState } from "react";
import type { QueuedMessage as QueuedMessageType } from "@/common/types/message";
import { Clock3, Loader2, Pencil, Send } from "lucide-react";
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

function deriveQueuedPreview(message: QueuedMessageType): QueuedPreview {
  const hasReviews = (message.reviews?.length ?? 0) > 0;
  const sanitizedText = hasReviews
    ? message.content.replace(/<review>[\s\S]*?<\/review>\s*/g, "").trim()
    : message.content;

  return {
    sanitizedText,
    fallbackLabel: "Queued message ready",
  };
}

export const QueuedMessage: React.FC<QueuedMessageProps> = (props) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const preview = deriveQueuedPreview(props.message);
  const queueStatusLabel =
    props.message.queueDispatchMode === "turn-end"
      ? "Sends after this turn"
      : "Sends after this step";

  const handleToggle = () => {
    setIsExpanded((prev) => !prev);
  };

  const handleSendImmediately = () => {
    if (isSending || !props.onSendImmediately) return;
    setIsSending(true);
    // The parent owns send error reporting; this surface only tracks whether another click is safe.
    props.onSendImmediately().then(
      () => setIsSending(false),
      () => setIsSending(false)
    );
  };

  const hasActions = props.onEdit != null || props.onSendImmediately != null;

  // Give queued follow-ups one cohesive pending surface so they read as the user's next message,
  // not as another generic system banner stacked above the composer.
  return (
    <ChatInputDecoration
      expanded={isExpanded}
      onToggle={handleToggle}
      className={props.className}
      contentClassName="py-1.5"
      dataComponent="QueuedMessageBanner"
      summary={
        <>
          <span className="bg-pending/10 text-pending flex size-5 shrink-0 items-center justify-center rounded-full">
            <Clock3 className="size-3" />
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="text-foreground font-medium">Queued</span>
            <span className="text-muted truncate">{queueStatusLabel}</span>
          </span>
        </>
      }
      renderExpanded={() => (
        <div
          className="border-pending/20 bg-pending/5 overflow-hidden rounded-lg border"
          data-component="QueuedMessageCard"
        >
          {/* Keep queued drafts bounded so long content never pushes the composer off-screen. */}
          <div className="max-h-[40vh] overflow-y-auto px-3 py-2.5">
            <UserMessageContent
              content={preview.sanitizedText || preview.fallbackLabel}
              reviews={props.message.reviews}
              fileParts={props.message.fileParts}
              variant="queued"
            />
          </div>

          {hasActions && (
            <div className="border-pending/10 bg-surface-secondary/60 flex flex-wrap items-center justify-end gap-1.5 border-t px-2 py-1.5">
              {props.onEdit && (
                <button
                  type="button"
                  onClick={props.onEdit}
                  className="text-muted hover:bg-hover hover:text-foreground flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors"
                >
                  <Pencil className="size-3" />
                  Edit
                </button>
              )}

              {props.onSendImmediately && (
                <button
                  type="button"
                  onClick={handleSendImmediately}
                  disabled={isSending}
                  className="bg-pending/10 text-pending hover:bg-pending/20 flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Send className="size-3" />
                  )}
                  {isSending ? "Sending…" : "Send now"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    />
  );
};
