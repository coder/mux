import React, { useState } from "react";
import type { QueuedMessage as QueuedMessageType } from "@/common/types/message";
import { Pencil, Send } from "lucide-react";
import { ChatInputDecoration } from "@/browser/components/ChatPane/ChatInputDecoration";
import { UserMessageContent } from "@/browser/features/Messages/UserMessageContent";
import {
  MonitorWakeMessage,
  extractMonitorWakeEvents,
  type MonitorWakeEvent,
} from "@/browser/features/Messages/MonitorWakeMessage";

interface QueuedMessageProps {
  message: QueuedMessageType;
  className?: string;
  onEdit?: () => void;
  onSendImmediately?: () => Promise<void>;
}

interface QueuedPreview {
  sanitizedText: string;
  fallbackLabel: string;
  /**
   * Parsed monitor wake events when the queue contains a backend-generated `<monitor-event>`
   * payload. The banner renders these as compact cards so the user never sees the raw XML.
   */
  monitorEvents: MonitorWakeEvent[];
}

function deriveQueuedPreview(message: QueuedMessageType): QueuedPreview {
  const hasReviews = (message.reviews?.length ?? 0) > 0;
  const reviewStripped = hasReviews
    ? message.content.replace(/<review>[\s\S]*?<\/review>\s*/g, "").trim()
    : message.content;

  // Only parse monitor blocks when the backend has flagged the queue as containing them, so
  // a user pasting similar XML in their own draft is rendered verbatim.
  const monitorExtract =
    message.containsMonitorEvents === true ? extractMonitorWakeEvents(reviewStripped) : null;
  const monitorEvents = monitorExtract?.events ?? [];
  const sanitizedText = monitorExtract ? monitorExtract.remainingContent : reviewStripped;

  return {
    sanitizedText,
    fallbackLabel: monitorEvents.length > 0 ? "" : "Queued message ready",
    monitorEvents,
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
  const hasMonitorEvents = preview.monitorEvents.length > 0;
  const hasVisibleText = preview.sanitizedText.length > 0;
  // A queue that's only a backend-generated wake has no user-authored text to edit; hide
  // Edit so we don't pop a misleadingly empty composer.
  const canEdit = !(hasMonitorEvents && !hasVisibleText);
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
          <div className="max-h-[40vh] space-y-2 overflow-y-auto">
            {(hasVisibleText || !hasMonitorEvents) && (
              <UserMessageContent
                content={preview.sanitizedText || preview.fallbackLabel}
                reviews={message.reviews}
                fileParts={message.fileParts}
                variant="queued"
              />
            )}
            {hasMonitorEvents && (
              <div className="space-y-2">
                {preview.monitorEvents.map((event, index) => (
                  <MonitorWakeMessage key={`${event.taskId}-${index}`} event={event} />
                ))}
              </div>
            )}
          </div>

          <div className="mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5">
            {onEdit && canEdit && (
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
