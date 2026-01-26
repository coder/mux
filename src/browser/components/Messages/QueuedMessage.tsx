import React, { useCallback, useState } from "react";
import type { ButtonConfig } from "./MessageWindow";
import { MessageWindow } from "./MessageWindow";
import { UserMessageContent } from "./UserMessageContent";
import type { QueuedMessage as QueuedMessageType } from "@/common/types/message";
import { Pencil } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";

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
  const { content } = message;
  const [isSending, setIsSending] = useState(false);

  const handleSendImmediately = useCallback(async () => {
    if (isSending || !onSendImmediately) return;
    setIsSending(true);
    try {
      await onSendImmediately();
    } finally {
      setIsSending(false);
    }
  }, [isSending, onSendImmediately]);

  const buttons: ButtonConfig[] = onEdit
    ? [
        {
          label: "Edit",
          onClick: onEdit,
          icon: <Pencil />,
        },
      ]
    : [];

  // Clickable "Queued" label with tooltip
  const queuedLabel = onSendImmediately ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void handleSendImmediately()}
          disabled={isSending}
          className="cursor-pointer hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          Queued
        </button>
      </TooltipTrigger>
      <TooltipContent align="center">Click to send immediately</TooltipContent>
    </Tooltip>
  ) : (
    "Queued"
  );

  return (
    <MessageWindow
      label={queuedLabel}
      variant="user"
      message={message}
      className={className}
      buttons={buttons}
    >
      <UserMessageContent
        content={content}
        reviews={message.reviews}
        fileParts={message.fileParts}
        variant="queued"
      />
    </MessageWindow>
  );
};
