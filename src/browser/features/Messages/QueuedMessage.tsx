import React, { useState } from "react";
import type { QueuedMessage as QueuedMessageType } from "@/common/types/message";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Clock3,
  Loader2,
  Pencil,
  Send,
} from "lucide-react";
import { ChatDockSurface } from "@/browser/components/ChatPane/chatDockColumn";
import { UserMessageContent } from "@/browser/features/Messages/UserMessageContent";
import { cn } from "@/common/lib/utils";
import { getErrorMessage } from "@/common/utils/errors";

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
  const [sendError, setSendError] = useState<string | null>(null);
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
    setSendError(null);
    props.onSendImmediately().then(
      () => setIsSending(false),
      (error: unknown) => {
        // Keep failures visible at the action that caused them while leaving the queued draft intact
        // for a retry; consuming this rejection without feedback makes IPC failures look like no-ops.
        setSendError(getErrorMessage(error));
        setIsSending(false);
      }
    );
  };

  const hasActions = props.onEdit != null || props.onSendImmediately != null;

  // Mirror the sent user-message shape so dispatching the queued draft removes temporary status
  // chrome instead of making the content jump from a full-width banner into a right-aligned bubble.
  return (
    <ChatDockSurface>
      <div
        className={cn("bg-surface-primary py-1.5", props.className)}
        data-component="QueuedMessageBanner"
      >
        <div className="ml-auto w-fit max-w-full" data-component="QueuedMessageGroup">
          {isExpanded && (
            <div
              className="overflow-hidden rounded-lg border border-[var(--color-user-border)] bg-[var(--color-user-surface)] shadow-sm"
              data-component="QueuedMessageCard"
            >
              {/* Keep queued drafts bounded so long content never pushes the composer off-screen. */}
              <div className="max-h-[40vh] overflow-y-auto px-3 py-2">
                <UserMessageContent
                  content={preview.sanitizedText || preview.fallbackLabel}
                  reviews={props.message.reviews}
                  fileParts={props.message.fileParts}
                  variant="sent"
                />
              </div>

              {sendError && (
                <div
                  role="alert"
                  className="border-toast-error-border/50 bg-toast-error-bg/50 text-toast-error-text flex items-start gap-1.5 border-t px-3 py-2 text-xs"
                >
                  <AlertCircle className="mt-0.5 size-3 shrink-0" />
                  <span className="min-w-0 break-words">{sendError}</span>
                </div>
              )}
            </div>
          )}

          <div
            className={cn(
              "flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-[11px]",
              isExpanded && "mt-1.5"
            )}
            data-component="QueuedMessageMeta"
          >
            {isExpanded && hasActions && (
              <div
                className="flex flex-wrap items-center justify-start gap-1"
                data-component="QueuedMessageActions"
              >
                {props.onEdit && (
                  <button
                    type="button"
                    onClick={props.onEdit}
                    className="text-muted hover:bg-hover hover:text-foreground flex h-6 items-center gap-1 rounded-md px-1.5 font-medium transition-colors"
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
                    className="bg-pending/10 text-pending hover:bg-pending/20 flex h-6 items-center gap-1 rounded-md px-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
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

            <button
              type="button"
              onClick={handleToggle}
              aria-expanded={isExpanded}
              className="text-muted hover:text-foreground ml-auto flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors"
              data-component="QueuedMessageStatus"
            >
              <Clock3 className="text-pending size-3 shrink-0" />
              <span className="text-foreground shrink-0 font-medium">Queued</span>
              <span className="truncate">{queueStatusLabel}</span>
              {isExpanded ? (
                <ChevronDown className="size-3 shrink-0" />
              ) : (
                <ChevronRight className="size-3 shrink-0" />
              )}
            </button>
          </div>
        </div>
      </div>
    </ChatDockSurface>
  );
};
