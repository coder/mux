import React, { useState } from "react";
import { Clipboard, ClipboardCheck } from "lucide-react";
import { cn } from "@/utils/cn";
import { MessageWindow, type ButtonConfig } from "./MessageWindow";
import type { DisplayedUserMessage, MuxImagePart } from "@/types";

interface UserMessageProps {
  message: DisplayedUserMessage;
  className?: string;
}

/**
 * User message component for shared/read-only rendering.
 */
export const UserMessage: React.FC<UserMessageProps> = ({ message, className }) => {
  const [copied, setCopied] = useState(false);
  const content = message.content;

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may not be available
    }
  };

  const buttons: ButtonConfig[] = [
    {
      label: copied ? "Copied" : "Copy",
      onClick: () => void copyToClipboard(),
      icon: copied ? <ClipboardCheck className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />,
    },
  ];

  return (
    <MessageWindow
      label={null}
      message={message}
      buttons={buttons}
      className={className}
      variant="user"
    >
      <UserMessageContent
        content={content}
        imageParts={message.imageParts}
      />
    </MessageWindow>
  );
};

interface UserMessageContentProps {
  content: string;
  imageParts?: MuxImagePart[];
}

const UserMessageContent: React.FC<UserMessageContentProps> = ({ content, imageParts }) => {
  return (
    <div className="flex flex-col gap-2">
      {/* Image attachments */}
      {imageParts && imageParts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {imageParts.map((img, i) => (
            <img
              key={i}
              src={img.url}
              alt={img.filename ?? `Image ${i + 1}`}
              className="max-w-[200px] max-h-[200px] rounded-md object-cover"
            />
          ))}
        </div>
      )}
      {/* Text content */}
      {content && (
        <div className={cn("whitespace-pre-wrap break-words text-sm")}>
          {content}
        </div>
      )}
    </div>
  );
};
